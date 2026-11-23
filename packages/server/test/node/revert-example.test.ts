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
      env?: Record<string, string>;
      "timeout-minutes"?: number;
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

  test("gives the bucket, the build pins and the analytics token to one step, and a signing key to none", () => {
    expect(workflow.env).toBeUndefined();
    expect(job.env).toBeUndefined();
    expect(job.steps.map(({ env }) => Object.keys(env ?? {}))).toEqual([
      [],
      ["GH_TOKEN", "TIDE_VERSION"],
      [
        "CHANNEL",
        "RUNTIME_VERSION",
        "MAX_FAILED_SHARE",
        "MIN_CHECKS",
        "TIDE_S3_ENDPOINT",
        "TIDE_S3_REGION",
        "TIDE_S3_BUCKET",
        "TIDE_S3_ACCESS_KEY_ID",
        "TIDE_S3_SECRET_ACCESS_KEY",
        "TIDE_BUILD_KEYID",
        "TIDE_BUILD_CERTIFICATE",
        "TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN",
        "TIDE_ANALYTICS_TOKEN",
        "TIDE_ANALYTICS_ACCOUNT_ID",
        "TIDE_ANALYTICS_DATASET",
      ],
    ]);
    expect(TEXT).not.toMatch(/TIDE_SIGNING_|TIDE_KMS_|id-token/);
  });

  // An expression in a script would put a value into it unquoted.
  test("no script holds an expression", () => {
    for (const { run } of job.steps) expect(run ?? "").not.toContain("${{");
  });
});

// The step's script runs as `shell: bash` does, over the document the real tide status prints, with fakes of the
// commands that would reach Cloudflare and write the bucket.
describe("the revert script", () => {
  const BASH = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
  const NEW_ID = "3b1d7c52-9e4a-4f08-a6c3-71d2e5b98f14"; // The rollout fixtures' new update.
  // Each call takes its command's next exit code, or 99 when none is left; builtins only, so it starts fast.
  const FAKE = `#!/bin/sh
for arg in "$@"; do printf '<%s>' "$arg"; done >> "$HOME/calls"
echo >> "$HOME/calls"
n=0
while [ -e "$HOME/$1.$n.done" ]; do n=$((n + 1)); done
: > "$HOME/$1.$n.done"
code=99
if [ -e "$HOME/$1.$n" ]; then read -r code < "$HOME/$1.$n"; fi
if [ "$1" = status ] && read -r document < "$HOME/status.json"; then printf '%s\\n' "$document"; fi
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
    status?: number; // Exit codes, in call order.
    stats?: number[];
    rollout?: number[];
  }
  /** Runs the script; `calls` holds each command's arguments, and `left` whatever else the script wrote. */
  async function runScript(scenario: Scenario) {
    const dir = join(work, `run-${runs++}`);
    mkdirSync(join(dir, "work"), { recursive: true });
    writeFileSync(join(dir, "status.json"), scenario.document ?? document);
    const codes = {
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

  const STATUS = "<status><--json>";
  const STATS = `<stats><--update><${NEW_ID}><--max-failed-share><5><--min-checks><500>`;
  const revert = (platform: string, channel = "both") =>
    `<rollout><revert><--channel><${channel}><--runtime-version><1.0.0><--platform><${platform}>`;
  const SLEEP = "<sleep><30>";

  test.each<[string, Scenario, number, string[]]>([
    ["no verdict is bad", { stats: [0, 0] }, 0, [STATUS, STATS, STATS]],
    [
      "one platform's update is bad",
      { stats: [0, 10], rollout: [0] },
      0,
      [STATUS, STATS, STATS, revert("android")],
    ],
    [
      "both are bad",
      { stats: [10, 10], rollout: [0, 0] },
      0,
      [STATUS, STATS, revert("ios"), STATS, revert("android")],
    ],
    [
      "one is bad and the other has no verdict",
      { stats: [4, 10], rollout: [0] },
      1,
      [STATUS, STATS, STATS, revert("android")],
    ],
    [
      "a revert exits 1, so it is retried in place",
      { channel: "low", stats: [10], rollout: [1, 1, 0] },
      0,
      [
        STATUS,
        STATS,
        revert("ios", "low"),
        SLEEP,
        revert("ios", "low"),
        SLEEP,
        revert("ios", "low"),
      ],
    ],
    [
      "a revert is refused",
      { channel: "high", stats: [10], rollout: [2] },
      1,
      [STATUS, STATS, revert("ios", "high")],
    ],
    [
      "a revert keeps exiting 1",
      { channel: "low", stats: [10], rollout: [1, 1, 1, 1, 1] },
      1,
      [
        STATUS,
        STATS,
        ...Array<string[]>(5)
          .fill([revert("ios", "low"), SLEEP])
          .flat(),
      ],
    ],
    ["the rollout is at 0%", { channel: "reverted" }, 0, [STATUS]],
    ["the rollout is at 100%", { channel: "complete" }, 0, [STATUS]],
    ["the pointer holds no rollout", { channel: "plain" }, 0, [STATUS]],
    ["the channel has no pointer", { channel: "none" }, 0, [STATUS]],
    ["the runtime has no pointer", { runtime: "2.0.0" }, 0, [STATUS]],
    ["status fails after printing its document", { status: 1 }, 1, [STATUS]],
    ["status fails with nothing printed", { status: 2, document: "" }, 2, [STATUS]],
    ["status prints nothing", { document: "" }, 4, [STATUS]],
    ["status prints another schema", { document: '{"schema":2,"pointers":[]}\n' }, 1, [STATUS]],
  ])("%s", async (_, scenario, code, calls) => {
    const result = await runScript(scenario);
    expect(result.calls).toEqual(calls);
    expect(result.code).toBe(code);
  });

  // Every code stats can exit with but 0 and 10, its neighbours, an uncaught error, and a command not found.
  test.each([1, 2, 3, 4, 5, 9, 11, 127])(
    "stats exits %i: the job fails and nothing is reverted",
    async (code) => {
      const result = await runScript({ channel: "low", stats: [code], rollout: [0] });
      expect(result.calls).toEqual([STATUS, STATS]);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("::warning::");
    },
  );

  test("a revert leaves a warning that holds no stored value", async () => {
    const result = await runScript({ channel: "low", stats: [10], rollout: [0] });
    expect(result.stdout).toBe(
      "::warning::Reverted the ios rollout: too many checks list its update as failed\n",
    );
  });

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
    expect(result.calls).toEqual([STATUS, STATS.replace(NEW_ID, hostile)]);
    expect([result.code, result.left]).toEqual([0, []]);
  });
});
