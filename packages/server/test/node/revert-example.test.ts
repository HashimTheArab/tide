import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parse } from "yaml";

import { decodePointer, diskPath, encodeRollout, replyKey } from "@tide-ota/protocol";

import { fixture } from "../shared/fixtures.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const TEXT = read("docs/examples/revert-rollouts.yml");

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Workflow {
  env?: Record<string, string>;
  permissions: unknown;
  jobs: Record<
    string,
    {
      concurrency: unknown;
      environment: string;
      env?: Record<string, string>;
      steps: Step[];
    }
  >;
}
const workflow = parse(TEXT) as Workflow;
const job = workflow.jobs.revert!;
const step = job.steps.at(-1)!;

describe("the job", () => {
  test("is one job in the writers' group, whose runs queue and are never cancelled", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["revert"]);
    expect(job.concurrency).toEqual({
      group: "tide-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("pins each action to the commit deploy-workers.yml pins it to", () => {
    const pins = (text: string) => text.match(/uses: .*/g) ?? [];
    const pinned = pins(read("docs/examples/deploy-workers.yml"));
    expect(pins(TEXT).length).toBeGreaterThan(0);
    for (const use of pins(TEXT)) {
      expect(use).toMatch(/^uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      expect(pinned).toContain(use);
    }
  });

  // docs/deploy.md puts required reviewers on production, which would hold each scheduled run.
  test("has an environment of its own", () => {
    expect(job.environment).toBe("tide-revert");
  });

  test("gives secrets to the last step only, and a signing key to none", () => {
    expect([workflow.env, job.env]).toEqual([undefined, undefined]);
    expect(JSON.stringify(job.steps.slice(0, -1))).not.toContain("secrets.");
    expect(TEXT).not.toMatch(/TIDE_SIGNING_|TIDE_KMS_|id-token/);
  });

  // An expression in a script would put a value into it unquoted.
  test("no script holds an expression", () => {
    for (const { run } of job.steps) expect(run ?? "").not.toContain("${{");
  });
});

// The step's script runs as `shell: bash` does, over the document the real tide status prints, with fakes of the
// commands that would reach Cloudflare or GitHub or write the bucket.
describe("the revert script", () => {
  const BASH = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
  const SHA = "a".repeat(40);
  const NEW_ID = "3b1d7c52-9e4a-4f08-a6c3-71d2e5b98f14"; // The rollout fixtures' new update.
  // Each call takes its command's next exit code, or 99 when none is left, and output; builtins only, so it starts fast.
  const FAKE = `#!/bin/sh
for arg in "$@"; do printf '<%s>' "$arg"; done >> "$HOME/calls"
echo >> "$HOME/calls"
n=0
while [ -e "$HOME/$1.$n.done" ]; do n=$((n + 1)); done
: > "$HOME/$1.$n.done"
code=99
if [ -e "$HOME/$1.$n" ]; then read -r code < "$HOME/$1.$n"; fi
if [ -e "$HOME/$1.$n.out" ] && read -r line < "$HOME/$1.$n.out"; then printf '%s\\n' "$line"; fi
exit "$code"
`;
  const work = mkdtempSync(join(tmpdir(), "tide-revert-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const bin = join(work, "bin");
  let document = "";
  let runs = 0;

  beforeAll(() => {
    mkdirSync(bin);
    for (const [name, text] of [
      ["tide", FAKE],
      ["gh", FAKE],
      ["sleep", '#!/bin/sh\nprintf "<sleep><%s>\\n" "$1" >> "$HOME/calls"\n'],
    ] as const) {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    }
    const root = join(work, "bucket");
    const put = (channel: string, platform: string, bytes: Uint8Array) => {
      const path = join(root, diskPath(replyKey(channel, "1.0.0", platform)));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    };
    const rollout = decodePointer(fixture("rollout-manifest.reply.json"));
    if (rollout.kind !== "rollout") throw new Error("the fixture is not a rollout");
    for (const [channel, percent] of [
      ["both", 50],
      ["low", 0.01],
      ["high", 99.99],
      ["reverted", 0],
      ["complete", 100],
    ] as const) {
      put(channel, "ios", encodeRollout({ ...rollout, percent }));
    }
    put("both", "android", encodeRollout({ ...rollout, percent: 10 }));
    put("plain", "ios", fixture("manifest.reply.json"));
    const status = spawnSync(
      process.execPath,
      [join(ROOT, "packages/cli/src/main.ts"), "status", "--json"],
      { env: { TIDE_DISK_DIR: root }, encoding: "utf8" },
    );
    expect([status.status, status.stderr]).toEqual([0, ""]);
    document = status.stdout;
  });

  interface Scenario {
    channel?: string;
    runtime?: string;
    document?: string;
    heads?: string[]; // What gh prints, in call order.
    gh?: number[]; // Exit codes, in call order.
    status?: number;
    stats?: number[];
    rollout?: number[];
  }
  /** Runs the script; `calls` holds each command's arguments, and `left` whatever else the script wrote. */
  async function runScript(scenario: Scenario) {
    const dir = join(work, `run-${runs++}`);
    mkdirSync(join(dir, "work"), { recursive: true });
    writeFileSync(join(dir, "status.0.out"), scenario.document ?? document);
    const heads = scenario.heads ?? [SHA, SHA, SHA];
    for (const [n, head] of heads.entries()) writeFileSync(join(dir, `api.${n}.out`), `${head}\n`);
    const codes = {
      api: scenario.gh ?? heads.map(() => 0),
      status: [scenario.status ?? 0],
      stats: scenario.stats,
      rollout: scenario.rollout,
    };
    for (const [command, list = []] of Object.entries(codes)) {
      for (const [n, code] of list.entries()) {
        writeFileSync(join(dir, `${command}.${n}`), `${code}\n`);
      }
    }
    writeFileSync(join(dir, "script.sh"), step.run!);
    const child = spawn(
      BASH,
      ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "script.sh")],
      {
        cwd: join(dir, "work"),
        env: {
          ...step.env,
          CHANNEL: scenario.channel ?? "both",
          RUNTIME_VERSION: scenario.runtime ?? "1.0.0",
          GITHUB_REPOSITORY: "o/app",
          GITHUB_SHA: SHA,
          PATH: `${bin}:${process.env.PATH}`,
          HOME: dir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.resume();
    const [code] = (await once(child, "close")) as [number | null];
    const calls = existsSync(join(dir, "calls"))
      ? readFileSync(join(dir, "calls"), "utf8").split("\n").slice(0, -1)
      : [];
    return { code, calls, stdout, left: readdirSync(join(dir, "work")) };
  }

  const HEAD = "<api><repos/o/app/git/ref/heads/main><--jq><.object.sha>";
  const STATUS = "<status><--json>";
  const STATS = `<stats><--update><${NEW_ID}><--max-failed-share><5><--min-checks><500>`;
  const revert = (platform: string, channel = "both") =>
    `<rollout><revert><--channel><${channel}><--runtime-version><1.0.0><--platform><${platform}>`;
  const SLEEP = "<sleep><30>";
  const warning = (platform: string) =>
    `::warning::Reverted the ${platform} rollout: too many checks list its update as failed\n`;
  const STALE = "::error::main has moved on from this commit, or its head could not be read\n";

  test.each<[string, Scenario, number, string[], string?]>([
    ["no verdict is bad", { stats: [0, 0] }, 0, [HEAD, STATUS, STATS, STATS]],
    [
      "one platform's update is bad",
      { stats: [0, 10], rollout: [0] },
      0,
      [HEAD, STATUS, STATS, STATS, HEAD, revert("android")],
      warning("android"),
    ],
    [
      "both are bad",
      { stats: [10, 10], rollout: [0, 0] },
      0,
      [HEAD, STATUS, STATS, HEAD, revert("ios"), STATS, HEAD, revert("android")],
      warning("ios") + warning("android"),
    ],
    [
      "one is bad and the other has no verdict",
      { stats: [4, 10], rollout: [0] },
      1,
      [HEAD, STATUS, STATS, STATS, HEAD, revert("android")],
      warning("android"),
    ],
    [
      "a revert exits 1, so it is retried in place",
      { channel: "low", stats: [10], rollout: [1, 1, 0] },
      0,
      [
        HEAD,
        STATUS,
        STATS,
        HEAD,
        revert("ios", "low"),
        SLEEP,
        revert("ios", "low"),
        SLEEP,
        revert("ios", "low"),
      ],
      warning("ios"),
    ],
    [
      "a revert is refused",
      { channel: "high", stats: [10], rollout: [2] },
      1,
      [HEAD, STATUS, STATS, HEAD, revert("ios", "high")],
    ],
    [
      "a revert keeps exiting 1",
      { channel: "low", stats: [10], rollout: [1, 1, 1, 1, 1] },
      1,
      [
        HEAD,
        STATUS,
        STATS,
        HEAD,
        ...Array<string[]>(5)
          .fill([revert("ios", "low"), SLEEP])
          .flat(),
      ],
    ],
    ["the rollout is at 0%", { channel: "reverted" }, 0, [HEAD, STATUS]],
    ["the rollout is at 100%", { channel: "complete" }, 0, [HEAD, STATUS]],
    ["the pointer holds no rollout", { channel: "plain" }, 0, [HEAD, STATUS]],
    ["the channel has no pointer", { channel: "none" }, 0, [HEAD, STATUS]],
    ["the runtime has no pointer", { runtime: "2.0.0" }, 0, [HEAD, STATUS]],
    ["status fails after printing its document", { status: 1 }, 1, [HEAD, STATUS]],
    ["status fails with nothing printed", { status: 2, document: "" }, 2, [HEAD, STATUS]],
    ["status prints nothing", { document: "" }, 4, [HEAD, STATUS]],
    ["main has moved on", { heads: ["b".repeat(40)] }, 1, [HEAD], STALE],
    ["gh fails", { gh: [1] }, 1, [HEAD], STALE],
    ["gh prints nothing", { heads: [""] }, 1, [HEAD], STALE],
    [
      "main moves on before a revert",
      { stats: [10], heads: [SHA, "b".repeat(40)] },
      1,
      [HEAD, STATUS, STATS, HEAD],
      STALE,
    ],
    [
      "gh fails before a revert",
      { stats: [10], gh: [0, 1] },
      1,
      [HEAD, STATUS, STATS, HEAD],
      STALE,
    ],
    [
      "main moves on between two reverts",
      { stats: [10, 10], rollout: [0], heads: [SHA, SHA, "b".repeat(40)] },
      1,
      [HEAD, STATUS, STATS, HEAD, revert("ios"), STATS, HEAD],
      warning("ios") + STALE,
    ],
    [
      "status prints another schema",
      { document: '{"schema":2,"pointers":[]}\n' },
      1,
      [HEAD, STATUS],
    ],
  ])("%s", async (_, scenario, code, calls, stdout = "") => {
    const result = await runScript(scenario);
    expect(result.calls).toEqual(calls);
    expect(result.code).toBe(code);
    expect(result.stdout).toBe(stdout);
  });

  // Every code stats can exit with but 0 and 10, its neighbours, an uncaught error, and a command not found.
  test.each([1, 2, 3, 4, 5, 9, 11, 127])(
    "stats exits %i: the job fails and nothing is reverted",
    async (code) => {
      const result = await runScript({ channel: "low", stats: [code], rollout: [0] });
      expect(result.calls).toEqual([HEAD, STATUS, STATS]);
      expect(result.code).toBe(1);
    },
  );

  test("a stored value that holds shell text reaches stats as one argument and runs nothing", async () => {
    const hostile = "$(touch pwned) `touch pwned`; touch pwned; * ' \" --json";
    const status = JSON.parse(document) as {
      pointers: { channel: string; new?: { updateId: string } }[];
    };
    const pointer = status.pointers.find((p) => p.channel === "low")!;
    pointer.new!.updateId = hostile;
    const result = await runScript({
      channel: "low",
      document: `${JSON.stringify(status)}\n`,
      stats: [0],
    });
    expect(result.calls).toEqual([HEAD, STATUS, STATS.replace(NEW_ID, hostile)]);
    expect([result.code, result.left]).toEqual([0, []]);
  });
});
