import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, inject, onTestFinished, test } from "vitest";

import {
  certificatePublicKey,
  decodeStoredReply,
  parseMultipart,
  sha256Base64Url,
  verifyExpoSignature,
} from "@tide/protocol";

import type { Manifest } from "../publish-fixture.ts";
import { run, tempRoot } from "../helpers.ts";
import {
  ANDROID,
  IOS,
  MAIN,
  diskObjects,
  env,
  installFakeExpo,
  main,
  project,
  useFixture,
} from "../publish-fixture.ts";

useFixture();

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const image = inject("image");
const exec = promisify(execFile);
const docker = async (...args: string[]) => (await exec("docker", args)).stdout.trim();
const tar = (...args: string[]) =>
  execFileSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Every regular file and symlink under `dir`, relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
    (p) => !lstatSync(join(dir, p)).isDirectory(),
  );
}

/** The names, `package.json` aside, that a workspace manifest lists as devDependencies. */
function devDependencies(): string[] {
  const manifests = ["package.json", ...allowlist().filter((f) => f.endsWith("/package.json"))];
  return manifests.flatMap((m) =>
    Object.keys(
      (
        JSON.parse(readFileSync(join(ROOT, m), "utf8")) as {
          devDependencies?: Record<string, string>;
        }
      ).devDependencies ?? {},
    ),
  );
}

/** The files Dockerfile.dockerignore admits to the build context. */
function allowlist(): string[] {
  return readFileSync(join(ROOT, "packages/server/Dockerfile.dockerignore"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("!"))
    .map((l) => l.slice(1));
}

describe("the Node image", () => {
  test("its config runs as node on 8787 and names no credential", async () => {
    const [config] = JSON.parse(await docker("image", "inspect", image.tag)) as [
      { Config: { User: string; Env: string[]; ExposedPorts: Record<string, unknown> } },
    ];
    expect(config.Config.User).toBe("node");
    expect(Object.keys(config.Config.ExposedPorts)).toEqual(["8787/tcp"]);
    const history = await docker(
      "image",
      "history",
      "--no-trunc",
      "--format",
      "{{.CreatedBy}}",
      image.tag,
    );
    for (const text of [...config.Config.Env, history]) {
      expect(text).not.toMatch(/\b(TIDE|AWS|CLOUDFLARE)_/);
    }
    expect(await docker("run", "--rm", image.tag, "node", "--version")).toBe(
      `v${readFileSync(join(ROOT, ".nvmrc"), "utf8").trim()}`,
    );
  });

  test("its own layers hold only the allowlisted files and production dependencies", async () => {
    const [base] = JSON.parse(await docker("image", "inspect", image.base)) as [
      { RootFS: { Layers: string[] } },
    ];
    const saved = JSON.parse(tar("-xOf", image.saved, "manifest.json")) as [
      { Config: string; Layers: string[] },
    ];
    const config = JSON.parse(tar("-xOf", image.saved, saved[0].Config)) as {
      rootfs: { diff_ids: string[] };
    };
    const own = config.rootfs.diff_ids.length - base.RootFS.Layers.length;
    expect(config.rootfs.diff_ids.slice(0, base.RootFS.Layers.length)).toEqual(base.RootFS.Layers);
    expect(own).toBeGreaterThan(0);

    const blobs = tempRoot();
    const tree = tempRoot();
    const layers = saved[0].Layers.slice(-own);
    tar("-xf", image.saved, "-C", blobs, ...layers);
    for (const layer of layers) {
      const entries = tar("-tf", join(blobs, layer)).split("\n").filter(Boolean);
      for (const entry of entries) {
        expect(entry).toMatch(/^app(\/|$)/);
        expect(entry).not.toMatch(/(^|\/)\.wh\./);
        expect(entry).not.toMatch(
          /(^|\/)(\.env[^/]*|\.npmrc|id_[^/]*|[^/]*\.(pem|key|p8|p12|pfx))$/,
        );
      }
      tar("-xf", join(blobs, layer), "-C", tree);
    }

    const app = join(tree, "app");
    const all = files(app);
    expect(all.filter((p) => !p.split("/").includes("node_modules")).sort()).toEqual(
      allowlist().sort(),
    );
    const store = readdirSync(join(app, "node_modules/.pnpm"));
    for (const name of devDependencies()) {
      expect(store.filter((d) => d.startsWith(`${name.replace("/", "+")}@`))).toEqual([]);
    }
    const bodies = [main.certificate, main.pkcs8].flatMap((pem) =>
      pem.split("\n").filter((l) => l.length >= 16 && !l.startsWith("-----")),
    );
    for (const path of all) {
      if (lstatSync(join(app, path)).isSymbolicLink()) continue;
      const text = readFileSync(join(app, path), "latin1");
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || bodies.some((b) => text.includes(b))) {
        throw new Error(`${relative(tree, join(app, path))} holds key or certificate text`);
      }
    }
  });

  test("serves /hc and each platform's signed /manifest from a bucket the CLI published, and stops on SIGTERM", async () => {
    const workspace = tempRoot();
    installFakeExpo(workspace);
    const app = project({ root: join(workspace, "apps", "app") });
    const bucket = tempRoot();
    // The key reaches only the CLI, through its environment; the mount holds what it published.
    const published = await run(
      MAIN,
      ["publish", "--channel", "main", "--project-root", app.root],
      env({ TIDE_DISK_DIR: bucket }),
      tempRoot(),
    );
    expect(published.code).toBe(0);
    execFileSync("chmod", ["-R", "a+rX", bucket]); // The container runs as uid 1000.
    const objects = diskObjects(bucket);

    const name = `tide-smoke-${randomUUID()}`;
    onTestFinished(async () => {
      await exec("docker", ["rm", "--force", name]).catch(() => undefined);
    });
    await docker(
      "run",
      "--detach",
      "--name",
      name,
      "--read-only",
      "--publish",
      "127.0.0.1::8787",
      "--volume",
      `${bucket}:/bucket:ro`,
      "--env",
      "TIDE_DISK_DIR=/bucket",
      image.tag,
    );
    const logs = spawn("docker", ["logs", "--follow", name], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    onTestFinished(() => {
      logs.kill();
    });
    let listening = false;
    for await (const line of createInterface({ input: logs.stdout })) {
      if ((listening = line === "tide listening on port 8787")) break;
    }
    if (!listening) throw new Error("the container stopped before listening");
    expect(await docker("exec", name, "id", "-u")).toBe("1000");
    const base = `http://${await docker("port", name, "8787/tcp")}`;

    const hc = await fetch(`${base}/hc`);
    expect([hc.status, await hc.text()]).toEqual([200, "ok"]);

    const key = await certificatePublicKey(main.certificate);
    for (const [platform, pointer] of [
      ["ios", IOS],
      ["android", ANDROID],
    ] as const) {
      const bytes = objects.get(pointer);
      if (bytes === undefined) throw new Error(`${pointer} was not published`);
      const stored = decodeStoredReply(bytes);
      if (stored.kind !== "manifest") throw new Error(`${pointer} is not a manifest`);
      const res = await fetch(`${base}/manifest`, {
        headers: {
          "expo-platform": platform,
          "expo-channel-name": "main",
          "expo-runtime-version": "1.0.0",
          "expo-protocol-version": "1",
          "expo-expect-signature": "true",
          accept: "multipart/mixed",
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("expo-protocol-version")).toBe("1");
      expect(res.headers.get("expo-manifest-filters")).toBe('channel="main"');
      const boundary = /^multipart\/mixed; boundary=(\S+)$/.exec(
        res.headers.get("content-type") ?? "",
      )?.[1];
      expect(boundary).toBe(stored.boundary);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body).toEqual(stored.body);

      // Parsed by the boundary the response advertises, as a client would.
      const part = parseMultipart(body, boundary ?? "").find((p) => p.name === "manifest");
      if (part?.signature === undefined) throw new Error("no signed manifest part");
      await verifyExpoSignature(part.body, part.signature, key, "main");
      const manifest = JSON.parse(new TextDecoder().decode(part.body)) as Manifest;
      expect(manifest.id).toBe(stored.updateId);
      const bundle = await fetch(`${base}${new URL(manifest.launchAsset.url).pathname}`);
      expect(bundle.status).toBe(200);
      expect(await sha256Base64Url(new Uint8Array(await bundle.arrayBuffer()))).toBe(
        manifest.launchAsset.hash,
      );
    }

    await docker("kill", "--signal", "TERM", name);
    expect(await docker("wait", name)).toBe("0");
  });
});
