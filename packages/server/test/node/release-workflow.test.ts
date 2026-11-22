import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  concurrency?: unknown;
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
const BASH = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();

interface StepRun {
  code: number | null;
  log: string;
  outputs: Record<string, string>;
}
/** Runs a step's script as `shell: bash` does, with RUNNER_TEMP and HOME in `dir` and `dir/bin` first on PATH; env may replace PATH. */
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
  const child = spawn(BASH, ["--noprofile", "--norc", "-eo", "pipefail", script], {
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

  // The build runs repository code, so it gets neither the OIDC token npm and attestations trust nor write access.
  test("only publish can mint an id token and only release can write contents", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.entries(jobs).map(([name, j]) => [name, j.permissions])).toEqual([
      ["build", undefined],
      ["publish", { "id-token": "write", attestations: "write" }],
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

  test("a run is never cancelled by another for the same tag", () => {
    expect(workflow.concurrency).toMatchObject({ "cancel-in-progress": false });
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
    const ids = job("build").steps.map((s) => s.id);
    const order = ["tag", "main", "setup", "gate", "version", "pack", "test-pack", "upload"];
    const at = order.map((id) => ids.indexOf(id));
    expect(at).not.toContain(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(step("build", "checkout").with?.["persist-credentials"]).toBe(false);
  });

  const accepted = [
    ["v1.2.3", "1.2.3", "latest"],
    ["v0.0.0", "0.0.0", "latest"],
    ["v1.2.3-rc.1", "1.2.3-rc.1", "next"],
    ["v0.1.0-0", "0.1.0-0", "next"],
    ["v2.0.0-alpha-1.x-y.7", "2.0.0-alpha-1.x-y.7", "next"],
  ];
  test("a v<semver> tag yields its version and dist-tag", async () => {
    const results = await Promise.all(
      accepted.map(async ([tag]) => {
        const r = await runStep("build", "tag", scratch(), { GITHUB_REF_NAME: tag! });
        return [tag, r.outputs.version, r.outputs["dist-tag"], r.code];
      }),
    );
    expect(results).toEqual(accepted.map((row) => [...row, 0]));
  });

  // Build metadata is dropped by npm, so the tag would no longer name the published version.
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
    expect(step("build", "pack").run).toContain('file="$RUNNER_TEMP/tarballs/tide-ota-$p.tgz"');
    expect(step("build", "test-pack").run).toContain('"$RUNNER_TEMP"/tarballs/*.tgz');
    expect(step("build", "upload").with?.path).toBe("${{ runner.temp }}/tarballs/*.tgz");
    expect(job("build").outputs?.["artifact-id"]).toBe("${{ steps.upload.outputs.artifact-id }}");
  });
});

describe("publish", () => {
  test("npm is checked before anything is published", () => {
    const ids = job("publish").steps.map((s) => s.id);
    expect(ids.indexOf("npm-version")).toBeLessThan(ids.indexOf("publish"));
    expect(ids.indexOf("npm-version")).toBeGreaterThan(-1);
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

  // Writers install a CLI only after gh attestation verify finds these tarballs' digests signed by this workflow.
  test("publish attests the downloaded tarballs, after publishing them", () => {
    const ids = job("publish").steps.map((s) => s.id);
    expect(ids.indexOf("attest")).toBeGreaterThan(ids.indexOf("publish"));
    const attest = step("publish", "attest");
    expect(attest.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/);
    expect(attest.with).toEqual({
      "subject-path": `${step("publish", "download").with?.path}/*.tgz`,
    });
  });

  // Runs for one dist-tag never interleave a check with another run's publishes.
  test("publish runs queue per dist-tag and are never cancelled", () => {
    expect(job("publish").concurrency).toEqual({
      group: "release-publish-${{ needs.build.outputs.dist-tag }}",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  // The real npm CLI reads its config; the step reads a local registry; `publish` goes to a fake that only records it.
  describe("against a local registry", () => {
    // Per package: each version on npm with the tarball body it was published from, and the dist-tags.
    type OnNpm = Record<string, { versions: Record<string, string>; tags: Record<string, string> }>;
    // Each run reads its own scenario under /<run>/, so runs can overlap. Like npm's CDN, a plain read may get an
    // older cached view; ?write=true always reads the current one.
    const scenarios = new Map<string, { current: OnNpm; cached: OnNpm }>();
    let registry = "";
    const integrity = (body: string) =>
      `sha512-${createHash("sha512").update(body).digest("base64")}`;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://registry");
      const [, run, p] = /^\/(\d+)\/@tide-ota%2f(\w+)$/.exec(url.pathname) ?? [];
      const scenario = run ? scenarios.get(run) : undefined;
      const view = url.searchParams.get("write") === "true" ? scenario?.current : scenario?.cached;
      const pkg = p ? view?.[p] : undefined;
      if (!pkg) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const name = `@tide-ota/${p}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name,
          "dist-tags": pkg.tags,
          versions: Object.fromEntries(
            Object.entries(pkg.versions).map(([version, body]) => [
              version,
              { name, version, dist: { integrity: integrity(body) } },
            ]),
          ),
        }),
      );
    });
    let realNpm = "";
    beforeAll(async () => {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      realNpm = spawnSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim();
    });
    afterAll(() => new Promise<void>((done) => server.close(() => done())));

    const tarball = (p: string) => `${p} tarball`;
    const names = PACKAGES.split(" ");
    const each = (entry: OnNpm[string]): OnNpm => Object.fromEntries(names.map((p) => [p, entry]));

    let runs = 0;
    async function publish(onNpm: OnNpm, version: string, distTag: string, cached = onNpm) {
      const run = String(runs++);
      scenarios.set(run, { current: onNpm, cached });
      const dir = scratch();
      const log = join(dir, "npm.log");
      executable(
        join(dir, "bin/npm"),
        `#!/bin/sh\nif [ "$1" != publish ]; then exec "${realNpm}" "$@"; fi\nprintf '%s\\n' "$*" >> "${log}"\n`,
      );
      writeFileSync(log, "");
      mkdirSync(join(dir, "tarballs"));
      for (const p of names) writeFileSync(join(dir, `tarballs/tide-ota-${p}.tgz`), tarball(p));
      const r = await runStep("publish", "publish", dir, {
        VERSION: version,
        DIST_TAG: distTag,
        npm_config_registry: `${registry}${run}/`,
        npm_config_userconfig: join(dir, "npmrc"),
        npm_config_globalconfig: join(dir, "global-npmrc"),
        npm_config_cache: join(dir, "npm-cache"),
        // Its registry check would otherwise hold each npm call open for half a second.
        npm_config_update_notifier: "false",
      });
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
      return { code: r.code, calls, dir };
    }
    const placeholders = each({ versions: { "0.0.1": "placeholder" }, tags: { latest: "0.0.1" } });
    const call = (dir: string, p: string, tag: string) =>
      `publish ${dir}/tarballs/tide-ota-${p}.tgz --provenance --access public --tag ${tag}`;

    test("a new version publishes every package in order under latest", async () => {
      const r = await publish(placeholders, "1.2.3", "latest");
      expect(r).toEqual({
        code: 0,
        dir: r.dir,
        calls: names.map((p) => call(r.dir, p, "latest")),
      });
    });

    test("prerelease tarballs publish under next", async () => {
      const r = await publish(placeholders, "1.2.3-rc.1", "next");
      expect(r.calls).toEqual(names.map((p) => call(r.dir, p, "next")));
    });

    // A rerun after protocol published resumes with the rest.
    test("a rerun skips a version npm holds with the same bytes", async () => {
      const protocol = {
        versions: { "0.0.1": "placeholder", "1.2.3": tarball("protocol") },
        tags: { latest: "1.2.3" },
      };
      const r = await publish({ ...placeholders, protocol }, "1.2.3", "latest");
      expect([r.code, r.calls]).toEqual([
        0,
        ["server", "cli"].map((p) => call(r.dir, p, "latest")),
      ]);
    });

    // Nothing to publish moves no tag, so a later release does not block finishing this one's GitHub Release.
    test("a fully published version publishes nothing, even after a later release", async () => {
      const onNpm = Object.fromEntries(
        names.map((p) => [
          p,
          { versions: { "1.2.3": tarball(p), "1.2.4": "later" }, tags: { latest: "1.2.4" } },
        ]),
      );
      const r = await publish(onNpm, "1.2.3", "latest");
      expect([r.code, r.calls]).toEqual([0, []]);
    });

    // Skipping would leave npm serving other bytes than the tested tarballs the GitHub Release carries.
    test("a version npm holds with other bytes fails before anything is published", async () => {
      const [placeholderTag, laterPackage] = await Promise.all([
        publish(placeholders, "0.0.1", "latest"),
        publish(
          {
            ...placeholders,
            server: { versions: { "1.2.3": "other bytes" }, tags: { latest: "1.2.3" } },
          },
          "1.2.3",
          "latest",
        ),
      ]);
      expect([placeholderTag, laterPackage].map((r) => [r.code, r.calls])).toEqual([
        [1, []],
        [1, []],
      ]);
    });

    // An older tag's rerun after a later release finished must not move server and cli back under latest.
    test("an older version never moves a dist-tag back", async () => {
      const later = { versions: { "1.2.4": "later" }, tags: { latest: "1.2.4" } };
      const protocol = {
        versions: { "1.2.3": tarball("protocol"), "1.2.4": "later" },
        tags: { latest: "1.2.4" },
      };
      const r = await publish({ protocol, server: later, cli: later }, "1.2.3", "latest");
      expect([r.code, r.calls]).toEqual([1, []]);
    });

    // npm's CDN serves a packument up to five minutes old, which can predate a release published seconds earlier.
    test("a stale cached packument neither moves a dist-tag back nor republishes a version", async () => {
      const later = each({ versions: { "1.2.4": "later" }, tags: { latest: "1.2.4" } });
      const behind = await publish(later, "1.2.3", "latest", placeholders);
      const done = Object.fromEntries(
        names.map((p) => [p, { versions: { "1.2.3": tarball(p) }, tags: { latest: "1.2.3" } }]),
      );
      const rerun = await publish(done, "1.2.3", "latest", placeholders);
      expect([behind, rerun].map((r) => [r.code, r.calls])).toEqual([
        [1, []],
        [0, []],
      ]);
    });

    const ordering = [
      ["1.2.3-rc.2", "1.2.3-rc.10", true],
      ["1.2.3-rc.10", "1.2.3-rc.2", false],
      ["1.2.3-alpha", "1.2.3-alpha.1", true],
      ["1.2.3-alpha.beta", "1.2.3-alpha.1", false],
      ["1.2.3-rc.1", "1.2.3", true],
      ["1.2.3", "1.2.3-rc.1", false],
      ["1.2.4-rc.1", "1.2.3", false],
      ["1.9.0", "1.10.0", true],
      ["1.10.0", "1.9.0", false],
    ] as const;
    // SemVer precedence decides "earlier": numeric identifiers by value, a prerelease before its release.
    test.each(ordering)("next at %s, then %s publishes: %s", async (tagged, version, publishes) => {
      const onNpm = each({ versions: { [tagged]: "x" }, tags: { next: tagged } });
      const r = await publish(onNpm, version, "next");
      expect([r.code, r.calls.length]).toEqual(publishes ? [0, names.length] : [1, 0]);
    });

    test("a package the registry does not answer for fails before anything is published", async () => {
      const { protocol: _, ...rest } = placeholders;
      const r = await publish(rest, "1.2.3", "latest");
      expect([r.code, r.calls]).toEqual([1, []]);
    });
  });
});

describe("release", () => {
  test("needs build and publish, gh targets this repository, and prerelease follows the dist-tag", () => {
    expect(job("release").needs).toEqual(["build", "publish"]);
    expect(job("release").env).toMatchObject({
      GH_REPO: "${{ github.repository }}",
      PRERELEASE: "${{ needs.build.outputs.dist-tag == 'next' }}",
    });
  });

  interface Asset {
    state: string;
    body: string;
  }
  interface Release {
    tag: string;
    draft: boolean;
    prerelease: boolean;
    assets: Record<string, Asset>;
  }
  const TAG = "v1.2.3-rc.1";
  // One fake for the GitHub CLI: the subcommands the step uses, over a JSON state file. Like gh, --clobber deletes an
  // existing asset before uploading; FAKE_GH_UPLOAD_FAILS makes every upload fail after that.
  const FAKE_GH = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const fail = (message) => { save(); process.stderr.write(message + "\\n"); process.exit(1); };
const [group, command, tag] = args;
const release = state.releases.find((r) => r.tag === tag);
const attach = (r) => {
  for (const f of args.slice(3).filter((a) => !a.startsWith("--"))) {
    const name = path.basename(f);
    if (r.assets[name] !== undefined) {
      if (!args.includes("--clobber")) fail("asset already exists");
      delete r.assets[name];
    }
    if (process.env.FAKE_GH_UPLOAD_FAILS) fail("upload failed");
    r.assets[name] = { state: "uploaded", body: fs.readFileSync(f, "utf8") };
  }
};
const digest = (body) => "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
if (group !== "release") fail("unexpected gh " + args.join(" "));
else if (command === "view" && !release) fail("release not found");
else if (command === "view" && args.includes("--json")) {
  const assets = Object.entries(release.assets).map(([name, a]) => ({ name, state: a.state, digest: digest(a.body) }));
  process.stdout.write(JSON.stringify({ assets }));
} else if (command === "view") process.stdout.write(tag);
else if (command === "create") {
  if (release) fail("already exists");
  const created = { tag, draft: args.includes("--draft"), prerelease: false, assets: {} };
  attach(created);
  state.releases.push(created);
} else if (command === "upload") attach(release || fail("release not found"));
else if (command === "edit") {
  const r = release || fail("release not found");
  if (args.includes("--draft=false")) r.draft = false;
  r.prerelease = args.includes("--prerelease=true");
} else fail("unexpected gh " + args.join(" "));
save();
`;
  const uploaded = (body: string): Asset => ({ state: "uploaded", body });
  const tarballs = Object.fromEntries(
    PACKAGES.split(" ").map((p) => [`tide-ota-${p}.tgz`, `${p} tarball`]),
  );
  const attached = Object.fromEntries(
    Object.entries(tarballs).map(([name, body]) => [name, uploaded(body)]),
  );
  // Only node and gh on PATH: the gate runs this step on contributors' machines, which need nothing beyond Node.
  const nodeOnly = join(work, "node-only");
  beforeAll(() => {
    mkdirSync(nodeOnly);
    symlinkSync(process.execPath, join(nodeOnly, "node"));
  });
  async function assets(releases: Release[], env: Record<string, string> = {}) {
    const dir = scratch();
    executable(join(dir, "bin/gh"), FAKE_GH);
    mkdirSync(join(dir, "tarballs"));
    for (const [name, body] of Object.entries(tarballs))
      writeFileSync(join(dir, "tarballs", name), body);
    const stateFile = join(dir, "gh.json");
    writeFileSync(stateFile, JSON.stringify({ releases, calls: [] }));
    const r = await runStep("release", "assets", dir, {
      GITHUB_REF_NAME: TAG,
      GH_REPO: "example/tide",
      PRERELEASE: "true",
      FAKE_GH_STATE: stateFile,
      PATH: `${join(dir, "bin")}:${nodeOnly}`,
      ...env,
    });
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { releases: Release[] };
    return { code: r.code, releases: state.releases };
  }
  const finished: Release = { tag: TAG, draft: false, prerelease: true, assets: attached };

  test("a first run creates the release with the tarballs and publishes it as a prerelease", async () => {
    expect(await assets([])).toEqual({ code: 0, releases: [finished] });
  });

  // A stopped run leaves a draft, perhaps holding an asset whose upload was cut off.
  test("a rerun keeps finished assets, replaces unfinished ones and publishes the draft", async () => {
    const draft: Release = {
      tag: TAG,
      draft: true,
      prerelease: false,
      assets: {
        "tide-ota-protocol.tgz": uploaded("protocol tarball"),
        "tide-ota-server.tgz": { state: "open", body: "" },
      },
    };
    expect(await assets([draft])).toEqual({ code: 0, releases: [finished] });
  });

  // Deleting a working download to upload the same bytes again risks losing it if the upload fails.
  test("a rerun on a finished release uploads nothing, so a failing upload loses no asset", async () => {
    expect(await assets([finished], { FAKE_GH_UPLOAD_FAILS: "1" })).toEqual({
      code: 0,
      releases: [finished],
    });
  });

  test("a finished asset with other bytes fails the step before anything changes", async () => {
    const draft: Release = {
      tag: TAG,
      draft: true,
      prerelease: false,
      assets: { "tide-ota-server.tgz": uploaded("other bytes") },
    };
    expect(await assets([draft])).toEqual({ code: 1, releases: [draft] });
  });
});

describe("checking a release", () => {
  const repo = /github\.com\/([\w.-]+\/[\w.-]+?)\.git$/.exec(
    (JSON.parse(read("package.json")) as { repository: { url: string } }).repository.url,
  )![1]!;
  const commands = (doc: string, name: string) =>
    [
      ...read(doc)
        .replaceAll(/\s*\\\n\s*/g, " ")
        .matchAll(new RegExp(`${name} ([^\\n]*)`, "g")),
    ].map((m) => m[1]!);

  // A payload names any repository its signer likes; only the certificate's identity proves the signer.
  test("every documented check pins the signer to this workflow on a hosted runner", () => {
    const verify = `--repo ${repo} --signer-workflow ${repo}/${WORKFLOW_PATH} --deny-self-hosted-runners`;
    for (const doc of ["docs/deploy.md", "docs/release.md"]) {
      const checks = commands(doc, "gh attestation verify");
      expect([doc, checks.length > 0]).toEqual([doc, true]);
      for (const args of checks)
        expect([doc, args]).toEqual([doc, expect.stringContaining(verify)]);
    }
  });

  // Anything npm fetched beyond the checked tarballs would run unverified with the signing key.
  test("the writer installs only the tarballs it checked, offline", () => {
    const installs = commands("docs/deploy.md", "npm install --prefix");
    expect(installs).toEqual([
      expect.stringMatching(
        /--offline .*\.\/tide-ota-cli-\S+\.tgz \.\/tide-ota-protocol-\S+\.tgz$/,
      ),
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

  test("publish and release download only the build's artifact", () => {
    for (const name of ["publish", "release"])
      expect(step(name, "download").with?.["artifact-ids"]).toBe(
        "${{ needs.build.outputs.artifact-id }}",
      );
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
