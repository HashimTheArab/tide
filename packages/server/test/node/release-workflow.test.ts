import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parse } from "yaml";

// Steps are run as written: each test executes a step's script with bash the way the runner does, against local
// fakes of npm's registry, the npm CLI and the GitHub CLI. Nothing here can publish or push.

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKFLOW_PATH = ".github/workflows/release.yml";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  "timeout-minutes"?: number;
  steps: Step[];
}
interface Workflow {
  on: unknown;
  permissions: unknown;
  concurrency: unknown;
  defaults: unknown;
  env: Record<string, string>;
  jobs: Record<string, Job>;
}
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const workflow = parse(read(WORKFLOW_PATH)) as Workflow;
const { jobs } = workflow;
const PACKAGES = workflow.env.PACKAGES!;
const job = (name: string) => jobs[name]!;
const step = (jobName: string, id: string) => {
  const found = job(jobName).steps.find((s) => s.id === id);
  if (!found) throw new Error(`${jobName} has no step ${id}`);
  return found;
};

const work = mkdtempSync(join(tmpdir(), "tide-release-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let dirs = 0;
const scratch = () => {
  const dir = join(work, String(dirs++));
  mkdirSync(join(dir, "bin"), { recursive: true });
  return dir;
};
const executable = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

interface StepRun {
  code: number | null;
  log: string;
  outputs: Record<string, string>;
}
/** Runs a step's script as `shell: bash` does, with RUNNER_TEMP and HOME in `dir` and `dir/bin` first on PATH. */
async function runStep(
  jobName: string,
  id: string,
  dir: string,
  env: Record<string, string> = {},
  cwd = dir,
): Promise<StepRun> {
  const script = join(dir, `${id}.sh`);
  const output = join(dir, `${id}.output`);
  writeFileSync(script, step(jobName, id).run!);
  writeFileSync(output, "");
  const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd,
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      HOME: dir,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: output,
      PACKAGES,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr.on("data", (d: Buffer) => (log += d.toString()));
  const code = await new Promise<number | null>((done) => child.on("close", done));
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { code, log, outputs };
}

describe("trigger and permissions", () => {
  test("only a pushed v* tag starts a release", () => {
    expect(workflow.on).toEqual({ push: { tags: ["v*"] } });
  });

  // The build runs repository code, so it gets neither the OIDC token npm trusts nor write access.
  test("only publish can mint an id token and only release can write contents", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.entries(jobs).map(([name, j]) => [name, j.permissions])).toEqual([
      ["build", undefined],
      ["publish", { "id-token": "write" }],
      ["release", { contents: "write" }],
    ]);
  });

  test("github.token is used only by the release job", () => {
    const { jobs: _, ...rest } = workflow;
    expect(JSON.stringify(rest)).not.toContain("github.token");
    expect(
      Object.entries(jobs)
        .filter(([, j]) => JSON.stringify(j).includes("github.token"))
        .map(([name]) => name),
    ).toEqual(["release"]);
  });

  test("runs never cancel each other and publishes queue per dist-tag", () => {
    expect(workflow.concurrency).toEqual({
      group: "release-${{ github.ref }}",
      "cancel-in-progress": false,
    });
    expect(job("publish").concurrency).toEqual({
      group: "release-publish-${{ needs.build.outputs.dist-tag }}",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  // The tests run scripts with the same flags, and pipefail keeps a failed gh or tar from passing through jq.
  test("scripts run under bash with pipefail, and every job has a timeout", () => {
    expect(workflow.defaults).toEqual({ run: { shell: "bash" } });
    for (const [name, j] of Object.entries(jobs))
      expect([name, typeof j["timeout-minutes"]]).toEqual([name, "number"]);
  });
});

describe("build", () => {
  test("validates the tag and main before installing, then gates, packs, tests and uploads in order", () => {
    expect(job("build").steps.map((s) => s.id)).toEqual([
      "checkout",
      "tag",
      "main",
      "node",
      "setup",
      "betterleaks",
      "gate",
      "version",
      "pack",
      "test-pack",
      "upload",
    ]);
    expect(step("build", "checkout").with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(step("build", "gate").run).toContain("node scripts/gate.mjs --base origin/main");
    expect(step("build", "setup").uses).toBe("./.github/actions/setup");
    expect(step("build", "betterleaks").uses).toBe("./.github/actions/betterleaks");
  });

  const accepted = [
    ["v1.2.3", "1.2.3", "latest", "false"],
    ["v0.0.0", "0.0.0", "latest", "false"],
    ["v1.2.3-rc.1", "1.2.3-rc.1", "next", "true"],
    ["v0.1.0-0", "0.1.0-0", "next", "true"],
    ["v2.0.0-alpha-1.x-y.7", "2.0.0-alpha-1.x-y.7", "next", "true"],
    ["v9007199254740991.0.0", "9007199254740991.0.0", "latest", "false"],
    [`v1.0.0-${"a".repeat(250)}`, `1.0.0-${"a".repeat(250)}`, "next", "true"],
  ];
  test("a v<semver> tag yields its version, dist-tag and prerelease flag", async () => {
    const results = await Promise.all(
      accepted.map(async ([tag]) => {
        const r = await runStep("build", "tag", scratch(), { GITHUB_REF_NAME: tag! });
        return [tag, r.outputs.version, r.outputs["dist-tag"], r.outputs.prerelease, r.code];
      }),
    );
    expect(results).toEqual(accepted.map((row) => [...row, 0]));
  });

  // Build metadata is dropped by npm; the limits are node-semver's (256 characters, safe integers).
  const rejected = [
    "1.2.3",
    "v1.2",
    "v1.2.3.4",
    "v01.2.3",
    "v1.02.3",
    "v1.2.3+b",
    "v1.2.3-",
    "v1.2.3-01",
    "v1.2.3-rc..1",
    "vx",
    "V1.2.3",
    "v9007199254740992.0.0",
    `v1.0.0-${"a".repeat(251)}`,
  ];
  test("any other tag fails with no outputs", async () => {
    const results = await Promise.all(
      rejected.map(async (tag) => {
        const r = await runStep("build", "tag", scratch(), { GITHUB_REF_NAME: tag });
        return [tag, r.code, r.outputs];
      }),
    );
    expect(results).toEqual(rejected.map((tag) => [tag, 1, {}]));
  });

  describe("the tagged commit must be on main", () => {
    const gitEnv = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Tide",
      GIT_AUTHOR_EMAIL: "tide@example.com",
      GIT_COMMITTER_NAME: "Tide",
      GIT_COMMITTER_EMAIL: "tide@example.com",
    };
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: work, ...gitEnv },
      });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const commit = (cwd: string, message: string) => {
      git(cwd, "commit", "--allow-empty", "-q", "-m", message);
      return git(cwd, "rev-parse", "HEAD");
    };
    const fixture = { clone: "", old: "", tip: "", side: "", lone: "" };
    beforeAll(() => {
      const origin = join(work, "origin");
      mkdirSync(origin);
      git(origin, "init", "-q", "-b", "main");
      fixture.old = commit(origin, "old");
      fixture.tip = commit(origin, "tip");
      git(origin, "checkout", "-q", "-b", "side", fixture.old);
      fixture.side = commit(origin, "side");
      fixture.clone = join(work, "clone");
      git(work, "clone", "-q", origin, fixture.clone);
      fixture.lone = join(work, "lone");
      mkdirSync(fixture.lone);
      git(fixture.lone, "init", "-q", "-b", "main");
      commit(fixture.lone, "lone");
    });
    const check = async (cwd: string, sha?: string) => {
      if (sha) git(cwd, "checkout", "-q", "--detach", sha);
      return (
        await runStep("build", "main", scratch(), { GITHUB_REF_NAME: "v1.0.0", ...gitEnv }, cwd)
      ).code;
    };

    test("main's tip and an older main commit pass", async () => {
      expect([
        await check(fixture.clone, fixture.tip),
        await check(fixture.clone, fixture.old),
      ]).toEqual([0, 0]);
    });
    test("a commit only on another branch fails", async () => {
      expect(await check(fixture.clone, fixture.side)).toBe(1);
    });
    test("a checkout without origin/main fails", async () => {
      expect(await check(fixture.lone)).toBe(1);
    });
  });

  // One list orders every package step, so it must name each published package after its @tide-ota dependencies.
  test("PACKAGES is protocol, server, cli: every published package, after its dependencies", () => {
    expect(PACKAGES).toBe("protocol server cli");
    const manifests = readdirSync(join(ROOT, "packages")).map(
      (dir) =>
        [
          dir,
          JSON.parse(read(`packages/${dir}/package.json`)) as {
            private?: boolean;
            version: string;
            dependencies?: Record<string, string>;
          },
        ] as const,
    );
    const order = PACKAGES.split(" ");
    expect(
      manifests
        .filter(([, m]) => !m.private)
        .map(([dir]) => dir)
        .sort(),
    ).toEqual([...order].sort());
    for (const [dir, m] of manifests) {
      for (const dep of Object.keys(m.dependencies ?? {}).filter((d) => d.startsWith("@tide-ota/")))
        expect(order.indexOf(dep.slice("@tide-ota/".length))).toBeLessThan(order.indexOf(dir));
    }
  });

  // The tag supplies the version inside the run; the repository never carries one.
  test("the repository stays at 0.0.0 and no step commits, tags or pushes", () => {
    for (const dir of readdirSync(join(ROOT, "packages")))
      expect([
        dir,
        (JSON.parse(read(`packages/${dir}/package.json`)) as { version: string }).version,
      ]).toEqual([dir, "0.0.0"]);
    expect(step("build", "version").run).toContain('npm pkg set "version=$VERSION"');
    for (const j of Object.values(jobs))
      for (const s of j.steps) expect(s.run ?? "").not.toMatch(/\bgit\s+(commit|tag|push)\b/);
  });

  // Publish and release read these exact files, so the tested tarballs are the published ones.
  test("test:pack runs on the tarballs the upload sends", () => {
    expect(step("build", "pack").run).toContain('pack --out "$file"');
    expect(step("build", "pack").run).toContain('file="$RUNNER_TEMP/tarballs/tide-ota-$p.tgz"');
    expect(step("build", "test-pack").run).toBe('pnpm test:pack "$RUNNER_TEMP"/tarballs/*.tgz');
    expect(step("build", "upload").with).toEqual({
      name: "tarballs-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/tarballs/*.tgz",
      "if-no-files-found": "error",
    });
    expect(job("build").outputs?.["artifact-id"]).toBe("${{ steps.upload.outputs.artifact-id }}");
  });
});

describe("publish", () => {
  test("downloads the build's artifact, checks npm, plans, then publishes", () => {
    expect(job("publish").steps.map((s) => s.id)).toEqual([
      "artifact-id",
      "setup-node",
      "download",
      "npm-version",
      "plan",
      "publish",
    ]);
    expect(job("publish").env).toEqual({
      VERSION: "${{ needs.build.outputs.version }}",
      DIST_TAG: "${{ needs.build.outputs.dist-tag }}",
    });
    expect(step("publish", "setup-node").with).toEqual({
      "node-version": "${{ needs.build.outputs.node }}",
    });
    expect(step("publish", "publish").env).toEqual({
      PUBLISH: "${{ steps.plan.outputs.publish }}",
    });
  });

  test("npm older than 11.5.1 fails the job", async () => {
    const versions = ["10.9.2", "11.4.9", "11.5.0", "11.5.1", "11.10.0", "12.0.0"];
    const results = await Promise.all(
      versions.map(async (version) => {
        const dir = scratch();
        executable(join(dir, "bin/npm"), `#!/bin/sh\necho ${version}\n`);
        return [version, (await runStep("publish", "npm-version", dir)).code];
      }),
    );
    expect(results).toEqual([
      ["10.9.2", 1],
      ["11.4.9", 1],
      ["11.5.0", 1],
      ["11.5.1", 0],
      ["11.10.0", 0],
      ["12.0.0", 0],
    ]);
  });

  describe("plan, against a local registry and the real npm CLI", () => {
    interface Doc {
      status: number;
      body?: unknown;
    }
    let docs = new Map<string, Doc>();
    let registry = "";
    const server = createServer((req, res) => {
      const doc = docs.get(req.url ?? "") ?? { status: 404, body: { error: "not found" } };
      res.writeHead(doc.status, { "content-type": "application/json" });
      res.end(JSON.stringify(doc.body ?? {}));
    });
    beforeAll(async () => {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });
    afterAll(() => new Promise<void>((done) => server.close(() => done())));

    const bytes = (p: string) => Buffer.from(`${p} tarball`);
    const integrity = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
    /** Serves each package's packument: version -> tarball bytes, plus dist-tags. */
    function serve(
      packages: Record<
        string,
        { versions: Record<string, Buffer>; tags: Record<string, string> } | Doc
      >,
    ) {
      docs = new Map(
        Object.entries(packages).map(([p, spec]) => {
          if ("status" in spec) return [`/@tide-ota%2f${p}`, spec];
          const name = `@tide-ota/${p}`;
          const versions = Object.fromEntries(
            Object.entries(spec.versions).map(([v, b]) => [
              v,
              { name, version: v, dist: { integrity: integrity(b) } },
            ]),
          );
          return [
            `/@tide-ota%2f${p}`,
            { status: 200, body: { name, "dist-tags": spec.tags, versions } },
          ];
        }),
      );
    }
    const placeholder = {
      versions: { "0.0.1": Buffer.from("placeholder") },
      tags: { latest: "0.0.1" },
    };
    const released = (p: string, latest = "1.2.3") => ({
      versions: { "0.0.1": Buffer.from("placeholder"), "1.2.3": bytes(p) },
      tags: { latest },
    });
    async function plan(dir = scratch()) {
      mkdirSync(join(dir, "tarballs"));
      for (const p of PACKAGES.split(" "))
        writeFileSync(join(dir, `tarballs/tide-ota-${p}.tgz`), bytes(p));
      return runStep("publish", "plan", dir, {
        VERSION: "1.2.3",
        DIST_TAG: "latest",
        npm_config_registry: registry,
        npm_config_userconfig: join(dir, "npmrc"),
        npm_config_globalconfig: join(dir, "global-npmrc"),
        npm_config_cache: join(dir, "npm-cache"),
      });
    }

    test("a new version plans every package in order", async () => {
      serve({ protocol: placeholder, server: placeholder, cli: placeholder });
      expect(await plan()).toMatchObject({ code: 0, outputs: { publish: "protocol server cli" } });
    });

    // A rerun after protocol published resumes with the rest, and publish runs exactly the planned tarballs.
    test("a rerun skips what is already published with the same bytes", async () => {
      serve({ protocol: released("protocol"), server: placeholder, cli: placeholder });
      const dir = scratch();
      const r = await plan(dir);
      expect(r).toMatchObject({ code: 0, outputs: { publish: "server cli" } });

      const log = join(dir, "npm.log");
      executable(join(dir, "bin/npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
      const published = await runStep("publish", "publish", dir, {
        PUBLISH: r.outputs.publish!,
        DIST_TAG: "latest",
      });
      expect(published.code).toBe(0);
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
        `publish ${dir}/tarballs/tide-ota-server.tgz --provenance --access public --tag latest`,
        `publish ${dir}/tarballs/tide-ota-cli.tgz --provenance --access public --tag latest`,
      ]);
    });

    test("prerelease tarballs publish under next", async () => {
      const dir = scratch();
      const log = join(dir, "npm.log");
      executable(join(dir, "bin/npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
      const r = await runStep("publish", "publish", dir, {
        PUBLISH: "protocol server cli",
        DIST_TAG: "next",
      });
      expect(r.code).toBe(0);
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(
        ["protocol", "server", "cli"].map(
          (p) =>
            `publish ${dir}/tarballs/tide-ota-${p}.tgz --provenance --access public --tag next`,
        ),
      );
    });

    test("a fully published version plans nothing", async () => {
      serve({ protocol: released("protocol"), server: released("server"), cli: released("cli") });
      expect(await plan()).toMatchObject({ code: 0, outputs: { publish: "" } });
    });

    // npm, the artifact and the Release must agree; a placeholder that collides with the tag counts as different.
    test("a version on npm with other bytes fails before publishing anything", async () => {
      serve({
        protocol: placeholder,
        server: { versions: { "1.2.3": Buffer.from("rebuilt") }, tags: { latest: "1.2.3" } },
        cli: placeholder,
      });
      const r = await plan();
      expect([r.code, r.outputs]).toEqual([1, {}]);
      expect(r.log).toContain("@tide-ota/server@1.2.3 is on npm with other bytes");
    });

    // v1 published protocol and stopped, v2 published everything: finishing v1 would move latest back for two.
    test("a skipped package whose dist-tag moved on fails while others still need publishing", async () => {
      serve({ protocol: released("protocol", "1.3.0"), server: placeholder, cli: placeholder });
      const r = await plan();
      expect([r.code, r.outputs]).toEqual([1, {}]);
      expect(r.log).toContain("@tide-ota/protocol@latest is 1.3.0, not 1.2.3");
    });

    test("a moved dist-tag does not block a rerun with nothing left to publish", async () => {
      serve({
        protocol: released("protocol", "1.3.0"),
        server: released("server", "1.3.0"),
        cli: released("cli", "1.3.0"),
      });
      expect(await plan()).toMatchObject({ code: 0, outputs: { publish: "" } });
    });

    test("a registry error or a missing package fails", async () => {
      serve({ protocol: placeholder, server: { status: 500 }, cli: placeholder });
      const failed = await plan();
      serve({ protocol: placeholder, server: placeholder });
      const missing = await plan();
      expect([failed.code, failed.outputs, missing.code, missing.outputs]).toEqual([1, {}, 1, {}]);
      expect([failed.log, missing.log]).toEqual([
        expect.stringContaining("@tide-ota/server: the registry answered 500"),
        expect.stringContaining("@tide-ota/cli: the registry answered 404"),
      ]);
    });
  });
});

describe("release", () => {
  test("needs build and publish, and gh targets this repository", () => {
    expect(job("release").needs).toEqual(["build", "publish"]);
    expect(job("release").steps.map((s) => s.id)).toEqual(["artifact-id", "download", "assets"]);
    expect(job("release").env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      PRERELEASE: "${{ needs.build.outputs.prerelease }}",
    });
    expect(step("release", "assets").run).not.toContain("--clobber");
  });

  interface Asset {
    id: number;
    name: string;
    state: string;
    content: string;
  }
  interface Release {
    tag: string;
    draft: boolean;
    prerelease: boolean;
    assets: Asset[];
  }
  interface GhState {
    listFails?: boolean;
    nextId: number;
    releases: Release[];
    calls: string[];
  }
  const TAG = "v1.2.3-rc.1";
  // One fake for the GitHub CLI: the subcommands the step uses, over a JSON state file.
  const FAKE_GH = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const fail = (message) => { save(); process.stderr.write(message + "\\n"); process.exit(1); };
const flag = (name) => args[args.indexOf(name) + 1];
const find = (tag) => state.releases.find((r) => r.tag === tag) || fail("release not found");
const [group, command, tag] = args;
if (group === "release" && command === "list") {
  if (state.listFails) fail("HTTP 502");
  process.stdout.write(JSON.stringify(state.releases.map((r) => ({ tagName: r.tag }))));
} else if (group === "release" && command === "create") {
  state.releases.push({ tag, draft: args.includes("--draft"), prerelease: false, assets: [] });
} else if (group === "release" && command === "view") {
  const assets = find(tag).assets.map((a) => ({
    name: a.name, state: a.state, size: Buffer.from(a.content, "base64").length,
    apiUrl: "https://api.github.com/repos/" + process.env.GH_REPO + "/releases/assets/" + a.id,
  }));
  process.stdout.write(JSON.stringify({ assets }));
} else if (group === "release" && command === "download") {
  const asset = find(tag).assets.find((a) => a.name === flag("--pattern") && a.state === "uploaded");
  if (!asset) fail("no assets to download");
  fs.writeFileSync(path.join(flag("--dir"), asset.name), Buffer.from(asset.content, "base64"));
} else if (group === "release" && command === "upload") {
  const release = find(tag);
  for (const f of args.slice(3)) {
    if (release.assets.some((a) => a.name === path.basename(f))) fail("asset already exists");
    release.assets.push({ id: state.nextId++, name: path.basename(f), state: "uploaded", content: fs.readFileSync(f).toString("base64") });
  }
} else if (group === "release" && command === "edit") {
  const release = find(tag);
  if (args.includes("--draft=false")) release.draft = false;
  release.prerelease = args.includes("--prerelease=true");
} else if (group === "api" && args[1] === "-X" && args[2] === "DELETE") {
  const prefix = "repos/" + process.env.GH_REPO + "/releases/assets/";
  if (!args[3].startsWith(prefix)) fail("wrong repository");
  const id = Number(args[3].slice(prefix.length));
  const release = state.releases.find((r) => r.assets.some((a) => a.id === id)) || fail("asset not found");
  release.assets = release.assets.filter((a) => a.id !== id);
} else fail("unexpected gh " + args.join(" "));
save();
`;
  const content = (p: string) => Buffer.from(`${p} tarball`).toString("base64");
  async function assets(releases: Release[], extra: Partial<GhState> = {}) {
    const dir = scratch();
    executable(join(dir, "bin/gh"), FAKE_GH);
    mkdirSync(join(dir, "tarballs"));
    for (const p of PACKAGES.split(" "))
      writeFileSync(join(dir, `tarballs/tide-ota-${p}.tgz`), Buffer.from(content(p), "base64"));
    const stateFile = join(dir, "gh.json");
    writeFileSync(stateFile, JSON.stringify({ nextId: 100, releases, calls: [], ...extra }));
    const r = await runStep("release", "assets", dir, {
      GITHUB_REF_NAME: TAG,
      GH_REPO: "example/tide",
      PRERELEASE: "true",
      FAKE_GH_STATE: stateFile,
    });
    return { ...r, dir, state: JSON.parse(readFileSync(stateFile, "utf8")) as GhState };
  }
  const uploaded = (id: number, p: string, c = content(p)) => ({
    id,
    name: `tide-ota-${p}.tgz`,
    state: "uploaded",
    content: c,
  });

  test("a first run creates a draft, attaches the tarballs, then publishes it as a prerelease", async () => {
    const r = await assets([]);
    expect(r.code).toBe(0);
    expect(r.state.calls).toEqual([
      "release list --limit 1000 --json tagName",
      `release create ${TAG} --draft --verify-tag --generate-notes`,
      `release view ${TAG} --json assets`,
      `release upload ${TAG} ${["protocol", "server", "cli"].map((p) => `${r.dir}/tarballs/tide-ota-${p}.tgz`).join(" ")}`,
      `release edit ${TAG} --draft=false --prerelease=true`,
    ]);
    expect(r.state.releases).toEqual([
      {
        tag: TAG,
        draft: false,
        prerelease: true,
        assets: [uploaded(100, "protocol"), uploaded(101, "server"), uploaded(102, "cli")],
      },
    ]);
  });

  // A stopped run leaves a draft; an upload cut off mid-way leaves an asset that never finished.
  test("a rerun keeps a matching asset, replaces an unfinished one, adds the rest and publishes the draft", async () => {
    const r = await assets([
      {
        tag: TAG,
        draft: true,
        prerelease: false,
        assets: [
          uploaded(7, "protocol"),
          { id: 8, name: "tide-ota-server.tgz", state: "starter", content: "" },
        ],
      },
    ]);
    expect(r.code).toBe(0);
    expect(r.state.calls).toEqual([
      "release list --limit 1000 --json tagName",
      `release view ${TAG} --json assets`,
      `release download ${TAG} --pattern tide-ota-protocol.tgz --dir ${r.dir}/existing`,
      "api -X DELETE repos/example/tide/releases/assets/8",
      `release upload ${TAG} ${r.dir}/tarballs/tide-ota-server.tgz ${r.dir}/tarballs/tide-ota-cli.tgz`,
      `release edit ${TAG} --draft=false --prerelease=true`,
    ]);
    expect(r.state.releases[0]).toEqual({
      tag: TAG,
      draft: false,
      prerelease: true,
      assets: [uploaded(7, "protocol"), uploaded(100, "server"), uploaded(101, "cli")],
    });
  });

  test("an asset with other bytes fails before anything on the release changes", async () => {
    const before: Release = {
      tag: TAG,
      draft: false,
      prerelease: true,
      assets: [
        { id: 8, name: "tide-ota-protocol.tgz", state: "starter", content: "" },
        uploaded(9, "server", Buffer.from("other").toString("base64")),
      ],
    };
    const r = await assets([structuredClone(before)]);
    expect(r.code).toBe(1);
    expect(r.log).toContain("tide-ota-server.tgz on the release is not the published tarball");
    expect(r.state.calls).toEqual([
      "release list --limit 1000 --json tagName",
      `release view ${TAG} --json assets`,
      `release download ${TAG} --pattern tide-ota-server.tgz --dir ${r.dir}/existing`,
    ]);
    expect(r.state.releases).toEqual([before]);
  });

  test("a failed release lookup or two releases for the tag fail without creating anything", async () => {
    const failed = await assets([], { listFails: true });
    const twice = await assets([
      { tag: TAG, draft: true, prerelease: false, assets: [] },
      { tag: TAG, draft: true, prerelease: false, assets: [] },
    ]);
    expect([failed.code, failed.state.calls, failed.state.releases]).toEqual([
      1,
      ["release list --limit 1000 --json tagName"],
      [],
    ]);
    expect([twice.code, twice.state.calls]).toEqual([
      1,
      ["release list --limit 1000 --json tagName"],
    ]);
  });
});

describe("artifact flow, pins and secrets", () => {
  test("every needs reference names a direct dependency", () => {
    for (const [name, j] of Object.entries(jobs)) {
      const needs = [j.needs ?? []].flat();
      const used = [...JSON.stringify(j).matchAll(/needs\.([\w-]+)/g)].map((m) => m[1]);
      expect([name, used.filter((n) => !needs.includes(n!))]).toEqual([name, []]);
    }
  });

  // An empty ID would make the download take every artifact in the run.
  test("publish and release download only the build's artifact, by a required ID", () => {
    for (const name of ["publish", "release"]) {
      expect(step(name, "download").with).toEqual({
        "artifact-ids": "${{ needs.build.outputs.artifact-id }}",
        path: "${{ runner.temp }}/tarballs",
        "digest-mismatch": "error",
      });
      expect(step(name, "artifact-id")).toMatchObject({
        env: { ARTIFACT_ID: "${{ needs.build.outputs.artifact-id }}" },
        run: 'test -n "$ARTIFACT_ID"',
      });
    }
  });

  // The scripts the tests run are the ones the runner runs, and no expression is spliced into shell code.
  test("no run script interpolates an expression", () => {
    for (const j of Object.values(jobs))
      for (const s of j.steps) expect(s.run ?? "").not.toContain("${{");
  });

  const localActions = (text: string) =>
    [...text.matchAll(/uses:\s*(\.\/\S+)/g)].map((m) => `${m[1]!.slice(2)}/action.yml`);

  test("no token or secret appears in the workflow or any local action it uses", () => {
    const seen = new Set<string>();
    const queue = [WORKFLOW_PATH];
    while (queue.length > 0) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const text = read(path);
      expect([path, text.match(/secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/g)]).toEqual([
        path,
        null,
      ]);
      queue.push(...localActions(text));
    }
    expect([...seen].sort()).toEqual([
      ".github/actions/betterleaks/action.yml",
      ".github/actions/setup/action.yml",
      WORKFLOW_PATH,
    ]);
  });

  const githubFiles = [
    ...readdirSync(join(ROOT, ".github/workflows")).map((f) => `.github/workflows/${f}`),
    ...readdirSync(join(ROOT, ".github/actions")).map((d) => `.github/actions/${d}/action.yml`),
  ];

  test("every action is local or pinned to a commit digest", () => {
    const uses = githubFiles.flatMap((path) =>
      [...read(path).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => [path, m[1]!]),
    );
    expect(uses.length).toBeGreaterThan(10);
    for (const [path, ref] of uses)
      expect([path, ref]).toEqual([
        path,
        expect.stringMatching(/^(\.\/[\w./-]+|[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40})$/),
      ]);
  });

  test("CI and release share one Betterleaks install", () => {
    const url = "github.com/betterleaks/betterleaks/releases/download";
    expect(githubFiles.filter((path) => read(path).includes(url))).toEqual([
      ".github/actions/betterleaks/action.yml",
    ]);
    for (const path of [".github/workflows/ci.yml", WORKFLOW_PATH])
      expect([path, localActions(read(path))]).toEqual([
        path,
        expect.arrayContaining([".github/actions/betterleaks/action.yml"]),
      ]);
  });
});
