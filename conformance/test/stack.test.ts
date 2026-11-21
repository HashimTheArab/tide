import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  baseKey,
  codeSigningCertificate,
  contentKey,
  decodeBaseRecord,
  NO_UPDATE_KEY,
  decodeStoredReply,
  diskPath,
  encodeStoredReply,
  patchKey,
  replyKey,
  sha256Base64Url,
} from "@tide/protocol";

import type { Stack } from "../src/stack.ts";
import { EXPORT_FILE, encodeProjectExport } from "../../packages/cli/src/publish-export.ts";
import { expectNoUpdate } from "../src/scenarios.ts";
import { tamperPatch, withStack } from "../src/stack.ts";
import { tideCli } from "../src/tide-cli.ts";

const FAKE_EXPO = fileURLToPath(new URL("../../packages/cli/test/fake-expo.ts", import.meta.url));
const FIXTURE_EXPORT = fileURLToPath(
  new URL("../../packages/cli/test/fixtures/export", import.meta.url),
);
const HOLD = fileURLToPath(new URL("hold-stack.ts", import.meta.url));
const HUNG_EXPORT = fileURLToPath(new URL("hung-export.ts", import.meta.url));
const LEAVE_WORKER = fileURLToPath(new URL("leave-worker.ts", import.meta.url));
const ANDROID_BUNDLE = "dist/_expo/static/js/android/index-android.hbc";
const MAIN = { channel: "main", runtimeVersion: "1.0.0" } as const;
const ANDROID = { ...MAIN, platform: "android" } as const;

const signingMetadata = (stack: Stack) => ({
  keyid: stack.identity.keyId,
  alg: "rsa-v1_5-sha256" as const,
});

/**
 * Writes an Expo project under the stack, signed by the run's identity, whose `expo` tools are the CLI tests' fake;
 * `expo export` runs `exporter` instead when it is given.
 */
function project(stack: Stack, exporter?: string): string {
  const root = join(stack.dir, "project");
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["expo", "expo-updates"]) {
    const instead = exporter === undefined ? "" : `[ "$1" = export ] && exec ${exporter} "$@"\n`;
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\n${tool === "expo" ? instead : ""}exec '${process.execPath}' '${FAKE_EXPO}' ${tool} "$@"\n`,
    );
    chmodSync(join(bin, tool), 0o755);
  }
  mkdirSync(join(root, "keys"));
  cpSync(stack.identity.certificateFile, join(root, "keys", "certificate.pem"));
  const config = {
    name: "Conformance",
    slug: "conformance",
    version: "1.0.0",
    runtimeVersion: MAIN.runtimeVersion,
    updates: {
      url: `${stack.serverUrl}/manifest`,
      codeSigningCertificate: "./keys/certificate.pem",
      codeSigningMetadata: signingMetadata(stack),
    },
  };
  writeFileSync(
    join(root, "app.config.mjs"),
    `export default () => (${JSON.stringify(config)});\n`,
  );
  return root;
}

/**
 * Writes at `<stack>/<name>` what `tide export` writes for the CLI tests' fixture export under the run's identity,
 * without running Expo; `bundle` replaces the Android launch bundle.
 */
function fixtureExport(stack: Stack, name: string, bundle?: Uint8Array): string {
  const out = join(stack.dir, name);
  cpSync(FIXTURE_EXPORT, join(out, "dist"), { recursive: true });
  if (bundle !== undefined) writeFileSync(join(out, ANDROID_BUNDLE), bundle);
  const value = {
    certificate: readFileSync(stack.identity.certificateFile, "utf8"),
    codeSigningMetadata: signingMetadata(stack),
    expoClient: { name: "Conformance", slug: "conformance", version: "1.0.0" },
    platforms: { android: { runtimeVersion: MAIN.runtimeVersion } },
  };
  writeFileSync(join(out, EXPORT_FILE), encodeProjectExport(value));
  return out;
}

/** Every file under `root` with its bytes as base64. */
function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(root, path), readFileSync(path).toString("base64"));
    }
  };
  walk(root);
  return out;
}

const hexOf = async (bytes: Uint8Array) => contentKey(await sha256Base64Url(new Uint8Array(bytes)));

/** Requests `url` with `headers`; resolves the status and the patch headers. */
function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; im: unknown; base: unknown }>((resolve, reject) => {
    request(url, { headers }, (res) => {
      res.resume().on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          im: res.headers.im,
          base: res.headers["expo-base-update-id"],
        }),
      );
    })
      .on("error", reject)
      .end();
  });
}

/** Starts a Node child running `script`; `line()` resolves its next stdout line. It is killed when the test ends. */
function child(script: string) {
  const proc = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => {
    proc.kill("SIGKILL");
  });
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  return {
    proc,
    async line(): Promise<string> {
      const { value, done } = await lines.next();
      if (done === true) throw new Error(`${script} ended before writing a line`);
      return value;
    },
    exited: once(proc, "exit"),
  };
}

/** Kills `pid` when the test finishes, in case the stack failed to. */
function killOnFinish(pid: number) {
  onTestFinished(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
}

/** Sends `socket`'s peer a line: a live peer answers, and a dead one's socket closes. */
function ask(socket: Socket): Promise<"answered" | "closed"> {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve("closed");
    socket.once("data", () => resolve("answered"));
    socket.once("close", () => resolve("closed"));
    socket.on("error", () => undefined);
    socket.write("are you there\n");
  });
}

/** Fails unless nothing listens at `url` and `dir` is gone. */
async function expectClosed({ dir, url }: { dir: string; url: string }) {
  expect(existsSync(dir)).toBe(false);
  await expect(fetch(`${url}/hc`)).rejects.toThrow("fetch failed");
}

describe("the harness stack", () => {
  test("tide export writes the project's export, signed for the run's identity, inside the stack", async () => {
    await withStack(async (stack) => {
      const out = join(stack.dir, "export");
      await tideCli(stack).export(project(stack), out, ["android"]);
      const written = JSON.parse(readFileSync(join(out, EXPORT_FILE), "utf8")) as {
        certificate: string;
        codeSigningMetadata: unknown;
      };
      expect(written.certificate).toBe(readFileSync(stack.identity.certificateFile, "utf8"));
      expect(written.codeSigningMetadata).toEqual(signingMetadata(stack));
      expect(
        readFileSync(join(out, ANDROID_BUNDLE)).equals(
          readFileSync(join(FIXTURE_EXPORT, ANDROID_BUNDLE.slice("dist/".length))),
        ),
      ).toBe(true);
    });
  });

  test("publishes a fixture export with a run-time identity, which tide probe verifies, and records the probe's replies", async () => {
    await withStack(async (stack) => {
      const cli = tideCli(stack);
      const from = fixtureExport(stack, "export");
      const ids = await cli.publish(from, "main");
      const hash = await sha256Base64Url(readFileSync(join(from, ANDROID_BUNDLE)));

      const before = stack.responses.length;
      expect(await cli.probe(ANDROID)).toBe(
        `manifest ${ids.android}: signature verified\nlaunch asset ${hash}: SHA-256 verified\n`,
      );
      const pointer = decodeStoredReply(
        readFileSync(join(stack.storeDir, diskPath(replyKey("main", "1.0.0", "android")))),
      );
      expect(stack.responses.slice(before)).toEqual([
        {
          path: "/manifest",
          expectSignature: `sig, keyid="${stack.identity.keyId}", alg="rsa-v1_5-sha256"`,
          status: 200,
          im: undefined,
          baseUpdateId: undefined,
          boundary: pointer.boundary,
          body: pointer.body,
        },
        {
          path: `/bundles/${contentKey(hash)}`,
          expectSignature: undefined,
          status: 200,
          im: undefined,
          baseUpdateId: undefined,
          boundary: undefined,
          body: undefined,
        },
      ]);
    });
  });

  test("the identity is generated per run, passes the code-signing profile and lives in the run's dir", async () => {
    const pems: string[] = [];
    for (let i = 0; i < 2; i++) {
      await withStack(async ({ dir, identity }) => {
        for (const file of [identity.keyFile, identity.certificateFile]) {
          expect(file.startsWith(`${dir}/`)).toBe(true);
        }
        expect(statSync(identity.keyFile).mode & 0o777).toBe(0o600);
        const pem = readFileSync(identity.certificateFile, "utf8");
        await codeSigningCertificate(pem, new Date());
        pems.push(pem);
      });
    }
    expect(pems[0]).not.toBe(pems[1]);
  });

  test("serves and records stored assets by content key from the store", async () => {
    await withStack(async (stack) => {
      const from = fixtureExport(stack, "export");
      await tideCli(stack).publish(from, "main");
      const metadata = JSON.parse(readFileSync(join(from, "dist", "metadata.json"), "utf8")) as {
        fileMetadata: { android: { assets: { path: string }[] } };
      };
      const [asset] = metadata.fileMetadata.android.assets;
      const bytes = readFileSync(join(from, "dist", asset?.path ?? ""));
      const path = `/assets/${await hexOf(bytes)}`;
      const missing = `/assets/${"0".repeat(64)}`;
      const before = stack.responses.length;
      const res = await fetch(`${stack.serverUrl}${path}`);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
      expect((await fetch(`${stack.serverUrl}${missing}`)).status).toBe(404);
      expect(stack.responses.slice(before)).toEqual([
        {
          path,
          expectSignature: undefined,
          status: 200,
          im: undefined,
          baseUpdateId: undefined,
          boundary: undefined,
          body: undefined,
        },
        {
          path: missing,
          expectSignature: undefined,
          status: 404,
          im: undefined,
          baseUpdateId: undefined,
          boundary: undefined,
          body: undefined,
        },
      ]);
    });
  });

  test("records a patched reply, and tamperPatch changes exactly the bytes of that one stored patch", async () => {
    await withStack(async (stack) => {
      const cli = tideCli(stack);
      const v1 = randomBytes(64 * 1024);
      const v2 = Buffer.from(v1);
      v2.write("marker v2", 1000);
      const u1 = await cli.publish(fixtureExport(stack, "u1", v1), "main");
      const u2 = await cli.publish(fixtureExport(stack, "u2", v2), "main");
      const [fromHex, toHex] = [await hexOf(v1), await hexOf(v2)];
      const key = patchKey(fromHex, toHex);

      const patched = {
        "a-im": "bsdiff",
        "expo-current-update-id": u1.android ?? "",
        "expo-requested-update-id": u2.android ?? "",
      };
      expect(await get(`${stack.serverUrl}/bundles/${toHex}`, patched)).toEqual({
        status: 226,
        im: "bsdiff",
        base: u1.android,
      });
      expect(stack.responses.at(-1)).toEqual({
        path: `/bundles/${toHex}`,
        expectSignature: undefined,
        status: 226,
        im: "bsdiff",
        baseUpdateId: u1.android,
        boundary: undefined,
        body: undefined,
      });

      const before = tree(stack.storeDir);
      expect(tamperPatch(stack.storeDir, fromHex, toHex)).toBe(join(stack.storeDir, key));
      const after = tree(stack.storeDir);
      const changed = [...after].filter(([path, bytes]) => before.get(path) !== bytes);
      expect(changed.map(([path]) => path)).toEqual([key]);
      expect([...after.keys()]).toEqual([...before.keys()]);
      const [was, now] = [before.get(key) ?? "", after.get(key) ?? ""].map((b) =>
        Buffer.from(b, "base64"),
      );
      expect(now?.length).toBe(was?.length);
      expect(now?.subarray(0, 32).equals(was?.subarray(0, 32) ?? Buffer.alloc(0))).toBe(true);
      expect(() => tamperPatch(stack.storeDir, toHex, fromHex)).toThrow(
        `${patchKey(toHex, fromHex)} is not stored`,
      );
    });
  });

  test("register-build stores an embedded base with its assets that a later publish patches from, and a rollback serves its directive", async () => {
    await withStack(async (stack) => {
      const cli = tideCli(stack);
      await cli.publish(fixtureExport(stack, "export"), "main"); // register-build needs the bucket to serve the identity first.
      const embedded = randomBytes(64 * 1024);
      const next = Buffer.from(embedded);
      next.write("marker u1", 2000);
      const build = join(stack.dir, "build");
      mkdirSync(join(build, "res", "raw"), { recursive: true });
      writeFileSync(join(build, "index.android.bundle"), embedded);
      const image = randomBytes(1024);
      writeFileSync(join(build, "res", "raw", "image.png"), image);
      const packagerHash = createHash("md5").update(image).digest("hex");
      const id = "6f1b0c2e-4d3a-4b5c-9e8f-7a6b5c4d3e2f";
      writeFileSync(
        join(build, "app.manifest"),
        JSON.stringify({ id, assets: [{ packagerHash }] }),
      );
      await cli.registerBuild({
        platform: "android",
        runtimeVersion: MAIN.runtimeVersion,
        manifest: join(build, "app.manifest"),
        bundle: join(build, "index.android.bundle"),
        assetsDir: join(build, "res"),
      });
      const record = decodeBaseRecord(readFileSync(join(stack.storeDir, diskPath(baseKey(id)))));
      expect(record).toMatchObject({
        kind: "embedded",
        updateId: id,
        assets: [{ key: packagerHash, hash: await sha256Base64Url(image) }],
      });

      await cli.publish(fixtureExport(stack, "u1", next), "main");
      const key = patchKey(await hexOf(embedded), await hexOf(next));
      expect(existsSync(join(stack.storeDir, key))).toBe(true);

      await cli.rollbackToEmbedded(ANDROID);
      expect(await cli.probe(ANDROID)).toBe(
        "directive rollBackToEmbedded: signature verified; a directive has no bundle to check\n",
      );
    });
  });

  test("spawn runs in the given directory, and close runs onClose steps while the servers still answer", async () => {
    const seen: unknown[] = [];
    await withStack(async (stack) => {
      const sub = join(stack.dir, "sub");
      mkdirSync(sub);
      const pwd = stack.spawn("/bin/pwd", [], {}, sub);
      const [out] = (await once(pwd.stdout, "data")) as [Buffer];
      expect(out.toString().trim()).toBe(sub);
      stack.onClose(async () => {
        seen.push((await fetch(`${stack.serverUrl}/hc`)).status, existsSync(stack.dir));
      });
    });
    expect(seen).toEqual([200, true]);
  });

  test("a failing CLI command throws with its message", async () => {
    await withStack(async (stack) => {
      await expect(tideCli(stack).publish(join(stack.dir, "missing"), "main")).rejects.toThrow(
        "tide publish exited 2: tide: the export directory is unreadable",
      );
    });
  });
});

describe("the harness stack shuts down", () => {
  const where = (s: Stack) => ({ dir: s.dir, url: s.serverUrl });

  test("on success", async () => {
    await expectClosed(await withStack((stack) => Promise.resolve(where(stack))));
  });

  test("on failure, passing the failure on", async () => {
    let seen = { dir: "", url: "" };
    await expect(
      withStack((stack) => {
        seen = where(stack);
        return Promise.reject(new Error("scenario failed"));
      }),
    ).rejects.toThrow("scenario failed");
    await expectClosed(seen);
  });

  test("on close, ending a CLI command still running", async () => {
    let ended: Promise<void> | undefined;
    const seen = await withStack((stack) => {
      ended = expect(tideCli(stack).probe(ANDROID)).rejects.toThrow(
        "tide probe was killed by SIGKILL",
      );
      return Promise.resolve(where(stack));
    });
    await ended;
    await expectClosed(seen);
  });

  test("on close, having killed a running export's Expo process, which staged its output inside the stack", async () => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    onTestFinished(() => {
      listener.close();
    });
    const connected = once(listener, "connection") as Promise<[Socket]>;
    const exporter = `'${process.execPath}' '${HUNG_EXPORT}' ${(listener.address() as AddressInfo).port}`;

    let ended: Promise<void> | undefined;
    const { seen, socket, report } = await withStack(async (stack) => {
      const out = join(stack.dir, "export");
      ended = expect(
        tideCli(stack).export(project(stack, exporter), out, ["android"]),
      ).rejects.toThrow("tide export was killed by SIGKILL");
      const [socket] = await connected;
      const [line] = (await once(socket, "data")) as [Buffer];
      const report = JSON.parse(line.toString()) as { pid: number; out: string };
      killOnFinish(report.pid);
      return { seen: where(stack), socket, report };
    });
    expect(report.out.startsWith(`${seen.dir}/`)).toBe(true);
    expect(await ask(socket)).toBe("closed");
    await ended;
    await expectClosed(seen);
  });

  test("on close, having killed a worker its command left running in its group after the command exited", async () => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    onTestFinished(() => {
      listener.close();
    });
    const connected = once(listener, "connection") as Promise<[Socket]>;
    const port = String((listener.address() as AddressInfo).port);

    const { seen, socket } = await withStack(async (stack) => {
      const leader = stack.spawn(process.execPath, [LEAVE_WORKER, port], {});
      const [socket] = await connected;
      const [line] = (await once(socket, "data")) as [Buffer];
      killOnFinish((JSON.parse(line.toString()) as { pid: number }).pid);
      expect(await once(leader, "close")).toEqual([0, null]);
      return { seen: where(stack), socket };
    });
    expect(await ask(socket)).toBe("closed");
    await expectClosed(seen);
  });

  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("on %s, exiting %i", async (signal, code) => {
    const held = child(HOLD);
    const seen = JSON.parse(await held.line()) as { dir: string; url: string };
    expect(existsSync(seen.dir)).toBe(true);
    expect((await fetch(`${seen.url}/hc`)).status).toBe(200);
    held.proc.kill(signal);
    expect(await held.exited).toEqual([code, null]);
    await expectClosed(seen);
  });
});

describe("the embedded scenario", () => {
  test("accepts a no-update answer only when it carries a directive signed for the run", async () => {
    await withStack(async (stack) => {
      await tideCli(stack).publish(fixtureExport(stack, "export"), "seed");
      const check = async () => {
        const before = stack.responses.length;
        const res = await fetch(`${stack.serverUrl}/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": MAIN.runtimeVersion,
            "expo-channel-name": MAIN.channel,
            "expo-expect-signature": `sig, keyid="${stack.identity.keyId}", alg="rsa-v1_5-sha256"`,
          },
        });
        await res.arrayBuffer();
        return stack.responses.slice(before);
      };
      await expectNoUpdate(stack, await check(), "first");

      // The same boundary with no parts: a client finds no directive, so nothing to verify, and reports no update.
      const path = join(stack.storeDir, diskPath(NO_UPDATE_KEY));
      const { boundary } = decodeStoredReply(readFileSync(path));
      const body = new Uint8Array(Buffer.from(`--${boundary}--\r\n`));
      writeFileSync(path, encodeStoredReply({ kind: "noUpdateAvailable", boundary, body }));
      const seen = await check();
      expect(seen.map((r) => [r.path, r.status, r.boundary])).toEqual([
        ["/manifest", 200, boundary],
      ]);
      await expect(expectNoUpdate(stack, seen, "second")).rejects.toThrow(
        `got ${NO_UPDATE_KEY}, which is not a noUpdateAvailable directive signed for the run`,
      );
    });
  });
});
