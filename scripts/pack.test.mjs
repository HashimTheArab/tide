// Installs each packed package alone into a fresh npm project and uses it as a consumer would.
// Usage: node scripts/pack.test.mjs [protocol.tgz server.tgz cli.tgz]; with no tarballs it packs the workspace.
// @tide-ota/* resolve only from the tarballs: the scope's registry is unreachable during the install.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const NAMES = ["@tide-ota/protocol", "@tide-ota/server", "@tide-ota/cli"];
const ALLOWED = /^package\/(package\.json|LICENSE|README\.md|dist\/.+)$/;

/** @param {string} cmd @param {string[]} args @param {import("node:child_process").SpawnSyncOptions} [options] */
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.error) throw r.error;
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}
/** @param {string} cmd @param {string[]} args @param {import("node:child_process").SpawnSyncOptions} [options] */
function ok(cmd, args, options) {
  const r = run(cmd, args, options);
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const work = mkdtempSync(join(tmpdir(), "tide-pack-"));
/** @typedef {{ name: string, private?: boolean, exports?: Record<string, string>, bin?: Record<string, string> }} Manifest */
/** @type {Map<string, { file: string, entries: string[], manifest: Manifest }>} */
const tarballs = new Map();
/** @type {Record<"protocol" | "server" | "cli", string>} */
const projects = { protocol: "", server: "", cli: "" };

/**
 * Installs `name` alone; the overrides only redirect @tide-ota/* deps its packed manifest declares.
 * @param {string} name @param {string} typesNode
 */
function consumer(name, typesNode) {
  const dir = join(work, name.split("/")[1]);
  mkdirSync(dir);
  const tgz = (/** @type {string} */ n) => `file:${tarballs.get(n)?.file}`;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "consumer",
      private: true,
      type: "module",
      dependencies: { [name]: tgz(name), "@types/node": typesNode },
      overrides: Object.fromEntries(NAMES.map((n) => [n, tgz(n)])),
    }),
  );
  // A @tide-ota/* package missing from the tarballs fails the install instead of coming from npm.
  writeFileSync(join(dir, ".npmrc"), "@tide-ota:registry=http://127.0.0.1:9/\nfetch-retries=0\n");
  ok("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: dir });
  return dir;
}

before(() => {
  let files = process.argv.slice(2).map((f) => resolve(f));
  if (files.length === 0) {
    const dest = join(work, "tarballs");
    for (const dir of ["protocol", "server", "cli"]) {
      ok("pnpm", ["pack", "--pack-destination", dest], { cwd: join(root, "packages", dir) });
    }
    files = readdirSync(dest).map((f) => join(dest, f));
  }
  for (const file of files) {
    const manifest = /** @type {Manifest} */ (
      JSON.parse(ok("tar", ["-xzOf", file, "package/package.json"]))
    );
    const entries = ok("tar", ["-tzf", file])
      .split("\n")
      .filter((e) => e && !e.endsWith("/")); // Files only; tar may list directories.
    assert.ok(!tarballs.has(manifest.name), `two tarballs for ${manifest.name}`);
    tarballs.set(manifest.name, { file, entries, manifest });
  }
  assert.deepEqual([...tarballs.keys()].sort(), [...NAMES].sort());

  const typesNode = /** @type {{ version: string }} */ (
    JSON.parse(readFileSync(join(root, "node_modules/@types/node/package.json"), "utf8"))
  ).version;
  projects.protocol = consumer("@tide-ota/protocol", typesNode);
  projects.server = consumer("@tide-ota/server", typesNode);
  projects.cli = consumer("@tide-ota/cli", typesNode);
});

// Not an after hook: with awaited top-level tests it runs as soon as the first ones finish.
process.once("exit", () => rmSync(work, { recursive: true, force: true }));

await test("tarballs hold only dist, LICENSE, README and a manifest pointing into dist", () => {
  for (const [name, { entries, manifest }] of tarballs) {
    assert.deepEqual(
      entries.filter((e) => !ALLOWED.test(e)),
      [],
      `${name} packs files outside dist`,
    );
    assert.ok(entries.includes("package/LICENSE"), `${name} has no LICENSE`);
    assert.equal(manifest.private, undefined, `${name} is private`);
    const targets = [
      ...Object.values(manifest.exports ?? {}),
      ...Object.values(manifest.bin ?? {}),
    ];
    assert.ok(targets.length > 0, `${name} exposes nothing`);
    for (const target of targets) {
      assert.match(target, /^\.\/dist\//, `${name} points ${target} outside dist`);
      assert.ok(entries.includes(`package/${target.slice(2)}`), `${name} lacks ${target}`);
    }
  }
});

await test("the tide bin prints usage and exits 2", () => {
  const r = run(join(projects.cli, "node_modules/.bin/tide"), [], { cwd: projects.cli });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^usage: tide status\n/);
});

await test("@tide-ota/protocol imports and hashes", () => {
  const bytes = "tide";
  writeFileSync(
    join(projects.protocol, "protocol.mjs"),
    `import { sha256Base64Url } from "@tide-ota/protocol";\n` +
      `process.stdout.write(await sha256Base64Url(new TextEncoder().encode(${JSON.stringify(bytes)})));\n`,
  );
  const want = createHash("sha256").update(bytes).digest("base64url");
  assert.equal(ok("node", ["protocol.mjs"], { cwd: projects.protocol }), want);
});

await test("@tide-ota/server/node serves /hc over a disk store and stops cleanly", async () => {
  const project = projects.server;
  mkdirSync(join(project, "bucket"));
  writeFileSync(
    join(project, "server.mjs"),
    `import { diskStore, startServer } from "@tide-ota/server/node";\n` +
      `const server = await startServer({ port: 0, hostname: "127.0.0.1", store: diskStore("bucket") });\n` +
      `const res = await fetch(\`http://127.0.0.1:\${server.address().port}/hc\`);\n` +
      `process.stdout.write(\`\${res.status} \${await res.text()}\`);\n` +
      `server.close((e) => process.stdout.write(e ? \` \${e.message}\` : " closed"));\n`,
  );
  // No process.exit: the child exits only once the server left no open handles.
  const child = spawn("node", ["server.mjs"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  /** @type {number | null} */
  const code = await new Promise((done) => child.on("close", done));
  assert.equal(code, 0, err);
  assert.equal(out, "200 ok closed");
});

// Protocol reaches this project only through the server's declared dependency.
await test("a TypeScript consumer type-checks against the published declarations", () => {
  const project = projects.server;
  writeFileSync(
    join(project, "consumer.ts"),
    [
      `import type { Server } from "node:http";`,
      `import { sha256Base64Url, type StoredReply } from "@tide-ota/protocol";`,
      `import { diskStore, startServer } from "@tide-ota/server/node";`,
      `import worker from "@tide-ota/server/workers";`,
      `const hash: Promise<string> = sha256Base64Url(new Uint8Array(1));`,
      `const server: Promise<Server> = startServer({ port: 0, store: diskStore(".") });`,
      `const reply: Response | Promise<Response> = worker.fetch(new Request("http://x/hc"));`,
      `export type Checked = [typeof hash, typeof server, typeof reply, StoredReply];`,
      "",
    ].join("\n"),
  );
  // skipLibCheck off: a declaration naming a global only Workers types define fails here.
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      files: ["consumer.ts"],
    }),
  );
  ok(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], { cwd: project });
});
