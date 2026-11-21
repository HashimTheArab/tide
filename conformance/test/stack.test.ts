import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

import { codeSigningCertificate, contentKey, patchKey, sha256Base64Url } from "@tide/protocol";

import type { Stack } from "../src/stack.ts";
import { tamperPatch, withStack } from "../src/stack.ts";
import { tideCli } from "../src/tide-cli.ts";

const FAKE_EXPO = fileURLToPath(new URL("../../packages/cli/test/fake-expo.ts", import.meta.url));
const HOLD = fileURLToPath(new URL("hold-stack.ts", import.meta.url));
const ANDROID_BUNDLE = "dist/_expo/static/js/android/index-android.hbc";
const MAIN = { channel: "main", runtimeVersion: "1.0.0" } as const;
const ANDROID = { ...MAIN, platform: "android" } as const;

/** Writes an Expo project under the stack whose `expo` tools are the CLI tests' fake, signed by the run's identity. */
function project(stack: Stack): string {
  const root = join(stack.dir, "project");
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["expo", "expo-updates"]) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\nexec '${process.execPath}' '${FAKE_EXPO}' ${tool} "$@"\n`,
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
      codeSigningMetadata: { keyid: stack.identity.keyId, alg: "rsa-v1_5-sha256" },
    },
  };
  writeFileSync(
    join(root, "app.config.mjs"),
    `export default () => (${JSON.stringify(config)});\n`,
  );
  return root;
}

/** Exports the fake project through the driver and returns the export directory. */
async function exported(stack: Stack): Promise<string> {
  const out = join(stack.dir, "export");
  await tideCli(stack).export(project(stack), out, ["android", "ios"]);
  return out;
}

/** Copies the export at `from` with `bundle` as its Android launch bundle. */
function withBundle(from: string, to: string, bundle: Uint8Array): string {
  cpSync(from, to, { recursive: true });
  writeFileSync(join(to, ANDROID_BUNDLE), bundle);
  return to;
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

/** Fails unless nothing listens at `url` and `dir` is gone. */
async function expectClosed({ dir, url }: { dir: string; url: string }) {
  expect(existsSync(dir)).toBe(false);
  await expect(fetch(`${url}/hc`)).rejects.toThrow("fetch failed");
}

describe("the harness stack", () => {
  test("publishes a fixture export with a run-time identity, which tide probe verifies, and records the probe's replies", async () => {
    await withStack(async (stack) => {
      const cli = tideCli(stack);
      const ids = await cli.publish(await exported(stack), "main");
      const bundle = readFileSync(join(stack.dir, "export", ANDROID_BUNDLE));
      const hash = await sha256Base64Url(bundle);

      const before = stack.responses.length;
      expect(await cli.probe(ANDROID)).toBe(
        `manifest ${ids.android}: signature verified\nlaunch asset ${hash}: SHA-256 verified\n`,
      );
      expect(stack.responses.slice(before)).toEqual([
        { path: "/manifest", status: 200, im: undefined, baseUpdateId: undefined },
        {
          path: `/bundles/${contentKey(hash)}`,
          status: 200,
          im: undefined,
          baseUpdateId: undefined,
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
      await tideCli(stack).publish(await exported(stack), "main");
      const dir = join(stack.dir, "export", "dist", "assets");
      const [name = ""] = readdirSync(dir);
      const bytes = readFileSync(join(dir, name));
      const path = `/assets/${await hexOf(bytes)}`;
      const missing = `/assets/${"0".repeat(64)}`;
      const before = stack.responses.length;
      const res = await fetch(`${stack.serverUrl}${path}`);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
      expect((await fetch(`${stack.serverUrl}${missing}`)).status).toBe(404);
      expect(stack.responses.slice(before)).toEqual([
        { path, status: 200, im: undefined, baseUpdateId: undefined },
        { path: missing, status: 404, im: undefined, baseUpdateId: undefined },
      ]);
    });
  });

  test("records a patched reply, and tamperPatch changes exactly the bytes of that one stored patch", async () => {
    await withStack(async (stack) => {
      const cli = tideCli(stack);
      const base = await exported(stack);
      const v1 = randomBytes(64 * 1024);
      const v2 = Buffer.from(v1);
      v2.write("marker v2", 1000);
      const u1 = await cli.publish(withBundle(base, join(stack.dir, "u1"), v1), "main");
      const u2 = await cli.publish(withBundle(base, join(stack.dir, "u2"), v2), "main");
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
        status: 226,
        im: "bsdiff",
        baseUpdateId: u1.android,
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

  test("register-build stores an embedded base that a later publish patches from, and a rollback serves its directive", async () => {
    await withStack(async (stack) => {
      const cli = tideCli(stack);
      const base = await exported(stack);
      await cli.publish(base, "main"); // register-build needs the bucket to serve the identity first.
      const embedded = randomBytes(64 * 1024);
      const next = Buffer.from(embedded);
      next.write("marker u1", 2000);
      const build = join(stack.dir, "build");
      mkdirSync(build);
      writeFileSync(join(build, "index.android.bundle"), embedded);
      const id = "6f1b0c2e-4d3a-4b5c-9e8f-7a6b5c4d3e2f";
      writeFileSync(join(build, "app.manifest"), JSON.stringify({ id, assets: [] }));
      await cli.registerBuild({
        platform: "android",
        runtimeVersion: MAIN.runtimeVersion,
        manifest: join(build, "app.manifest"),
        bundle: join(build, "index.android.bundle"),
      });
      expect(existsSync(join(stack.storeDir, "bases", id))).toBe(true);

      await cli.publish(withBundle(base, join(stack.dir, "u1"), next), "main");
      const key = patchKey(await hexOf(embedded), await hexOf(next));
      expect(existsSync(join(stack.storeDir, key))).toBe(true);

      await cli.rollbackToEmbedded(ANDROID);
      expect(await cli.probe(ANDROID)).toBe(
        "directive rollBackToEmbedded: signature verified; a directive has no bundle to check\n",
      );
    });
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
      ended = expect(tideCli(stack).probe(ANDROID)).rejects.toThrow("The operation was aborted");
      return Promise.resolve(where(stack));
    });
    await ended;
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
