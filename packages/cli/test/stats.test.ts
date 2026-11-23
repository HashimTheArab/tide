import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { describe, expect, onTestFinished, test } from "vitest";

import type { RolloutSide } from "../../server/src/core/analytics.ts";
import type { FakeSqlApi, SqlFault } from "./fake-sql-api.ts";
import { manifestPoint } from "../../server/src/core/analytics.ts";
import { STATS_USAGE, stats } from "../src/stats.ts";
import { FAKE_ACCOUNT, FAKE_BODY, FAKE_TOKEN, startFakeSqlApi } from "./fake-sql-api.ts";
import { run } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const ROOT = new URL("../../../", import.meta.url);
const ENV = { TIDE_ANALYTICS_ACCOUNT_ID: FAKE_ACCOUNT, TIDE_ANALYTICS_TOKEN: FAKE_TOKEN };
const ID = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const [A, B, C] = [ID(0xa), ID(0xb), ID(0xc)];

async function fake(): Promise<FakeSqlApi> {
  const api = await startFakeSqlApi();
  onTestFinished(() => api.close());
  return api;
}

interface Check {
  readonly running?: string;
  readonly failed?: readonly string[];
  readonly side?: RolloutSide;
  readonly channel?: string;
  readonly runtime?: string;
  readonly platform?: "ios" | "android";
}

/** The point the Worker writes for a client that runs `running` and lists `failed`. */
function check(c: Check) {
  const headers: Record<string, string | undefined> = {
    "expo-current-update-id": c.running,
    "expo-recent-failed-update-ids": c.failed?.map((id) => `"${id}"`).join(", "),
  };
  return manifestPoint(
    "manifest",
    c.side ?? "none",
    c.platform ?? "ios",
    c.channel ?? "main",
    c.runtime ?? "1.0.0",
    (name) => headers[name],
  );
}

/** Runs the command in process against `api`, the one way to replace the endpoint. */
async function tide(
  api: { readonly origin: string },
  args: readonly string[] = [],
  env: Record<string, string> = ENV,
  timeoutMs?: number,
) {
  let stdout = "";
  let stderr = "";
  const io = {
    out: (line: string) => (stdout += `${line}\n`),
    err: (line: string) => (stderr += `${line}\n`),
  };
  const options = { origin: api.origin, ...(timeoutMs !== undefined && { timeoutMs }) };
  const code = await stats(args, env, io, options);
  return { code, stdout, stderr };
}
const success = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
const failure = (code: number, message: string) => ({
  code,
  stdout: "",
  stderr: `tide: ${message}\n`,
});
const document = (value: unknown) => `${JSON.stringify(value)}\n`;
const verdictArgs = (share: string, min: string, update = A) => [
  "--update",
  update,
  "--max-failed-share",
  share,
  "--min-checks",
  min,
];
/** The document of a verdict on `A` over the last 24 hours. */
const verdictDocument = (verdict: object) =>
  document({
    schema: 1,
    windowHours: 24,
    currentUpdates: null,
    failedUpdates: null,
    rolloutSides: null,
    verdict: { updateId: A, ...verdict },
  });

describe("reports", () => {
  /** Sampled points: every count differs from the number of rows. */
  async function sampled() {
    const api = await fake();
    api.write(check({ running: A, side: "new" }), 10);
    api.write(check({ running: A, side: "new" }), 7);
    api.write(check({ running: B, failed: [A, C], side: "earlier" }), 5);
    // The client repeats an ID; its check counts once for it.
    api.write(check({ running: B, failed: [A, A] }), 3);
    api.write(check({}), 2);
    return api;
  }

  test("text: weighted checks per current update, per failed ID in a list and per side", async () => {
    const api = await sampled();
    expect(await tide(api)).toEqual(
      success(`checks, not devices, last 24 h:
current update ${A} 17
current update ${B} 8
current update - 2
failed update ${A} 8
failed update ${C} 5
rollout side new 17
rollout side earlier 5
rollout side none 5
`),
    );
  });

  test.each(["strings", "numbers"])(
    "--json: the same counts, whether the API sends them as %s",
    async (form) => {
      const api = await sampled();
      if (form === "numbers") api.numbers();
      expect(await tide(api, ["--json"])).toEqual(
        success(
          document({
            schema: 1,
            windowHours: 24,
            currentUpdates: {
              truncated: false,
              counts: [
                { updateId: A, checks: 17 },
                { updateId: B, checks: 8 },
                { updateId: null, checks: 2 },
              ],
            },
            failedUpdates: {
              truncated: false,
              counts: [
                { updateId: A, checks: 8 },
                { updateId: C, checks: 5 },
              ],
            },
            rolloutSides: {
              truncated: false,
              counts: [
                { side: "new", checks: 17 },
                { side: "earlier", checks: 5 },
                { side: "none", checks: 5 },
              ],
            },
            verdict: null,
          }),
        ),
      );
    },
  );

  test("no checks at all is said, and is not an error", async () => {
    const api = await fake();
    api.write(check({ running: A }), 4, 25); // Outside the default window.
    expect(await tide(api)).toEqual(
      success(`checks, not devices, last 24 h:
current update: no checks
failed update: no checks
rollout side: no checks
`),
    );
  });

  test("a point of a 0.1.0 Worker, which wrote no side, has none reported", async () => {
    const api = await fake();
    const point = check({ running: A });
    api.write({ ...point, blobs: point.blobs.slice(0, 6) }, 2);
    expect((await tide(api)).stdout).toContain("\nrollout side - 2\n");
  });

  test("the window, dataset, channel, runtime and platform each narrow the counts", async () => {
    const api = await fake();
    api.write(check({ running: A }), 1);
    api.write(check({ running: A, channel: "beta" }), 20);
    api.write(check({ running: A, runtime: "2.0.0" }), 300);
    api.write(check({ running: A, platform: "android" }), 4000);
    api.write(check({ running: A }), 50_000, 47);
    api.write(check({ running: A }), 600_000, 0, "tide_staging");
    const count = async (args: string[], dataset?: string) =>
      /^current update \S+ (\d+)$/m.exec(
        (await tide(api, args, { ...ENV, TIDE_ANALYTICS_DATASET: dataset ?? "" })).stdout,
      )?.[1];
    expect(await count([])).toBe("4321");
    expect(await count(["--window", "2d"])).toBe("54321");
    expect(await count(["--window", "46h"])).toBe("4321");
    expect(await count(["--channel", "beta"])).toBe("20");
    expect(await count(["--runtime-version", "2.0.0"])).toBe("300");
    expect(await count(["--platform", "android"])).toBe("4000");
    expect(
      await count(["--channel", "main", "--runtime-version", "1.0.0", "--platform", "ios"]),
    ).toBe("1");
    expect(await count([], "tide_staging")).toBe("600000");
  });

  test("1,000 groups are whole; one more is marked truncated in text and --json", async () => {
    const api = await fake();
    for (let i = 1; i <= 1000; i++) api.write(check({ running: ID(i), failed: [ID(i)] }), 2);
    const whole = JSON.parse((await tide(api, ["--json"])).stdout) as Report;
    expect(whole.currentUpdates.truncated).toBe(false);
    expect(whole.failedUpdates.truncated).toBe(false);
    expect(whole.currentUpdates.counts).toHaveLength(1000);
    expect((await tide(api)).stdout).not.toContain("truncated");

    api.write(check({ running: ID(2000), failed: [ID(2000)] }), 1);
    const cut = JSON.parse((await tide(api, ["--json"])).stdout) as Report;
    expect(cut.currentUpdates.truncated).toBe(true);
    expect(cut.failedUpdates.truncated).toBe(true);
    expect(cut.rolloutSides.truncated).toBe(false);
    expect(cut.currentUpdates.counts).toEqual(whole.currentUpdates.counts);
    const { code, stdout } = await tide(api);
    expect(code).toBe(0);
    expect(stdout).toContain(
      "\ncurrent update: truncated at 1000 rows, so lower counts are left out\n",
    );
    expect(stdout).toContain(
      "\nfailed update: truncated at 1000 rows, so every count is a lower bound\n",
    );
    expect(stdout).not.toContain("rollout side: truncated");
  });
});

interface Report {
  readonly currentUpdates: { readonly truncated: boolean; readonly counts: readonly unknown[] };
  readonly failedUpdates: { readonly truncated: boolean; readonly counts: readonly unknown[] };
  readonly rolloutSides: { readonly truncated: boolean };
}

describe("verdict", () => {
  test("a bad update exits with a code nothing else uses, in text and --json", async () => {
    const api = await fake();
    api.write(check({ running: A }), 97);
    api.write(check({ running: B, failed: [C, A] }), 3);
    expect(await tide(api, verdictArgs("2.99", "100"))).toEqual(
      success(
        `checks, not devices, last 24 h:\nupdate ${A} failed in 3 of 100: bad, over 2.99%\n`,
        10,
      ),
    );
    expect(await tide(api, [...verdictArgs("2.99", "100"), "--json"])).toEqual(
      success(
        verdictDocument({
          maxFailedShare: 2.99,
          minChecks: 100,
          result: "bad",
          failedChecks: 3,
          checks: 100,
        }),
        10,
      ),
    );
  });

  test.each([
    ["exactly at the share", "3", "100", "ok", "ok, not over 3%"],
    ["below the share", "3.01", "100", "ok", "ok, not over 3.01%"],
    [
      "above the share below min-checks",
      "0",
      "101",
      "notEnoughChecks",
      "not enough checks, fewer than 101",
    ],
  ])("%s exits 0", async (_, share, min, result, reason) => {
    const api = await fake();
    api.write(check({ running: A }), 97);
    api.write(check({ running: B, failed: [A] }), 3);
    expect(await tide(api, verdictArgs(share, min))).toEqual(
      success(`checks, not devices, last 24 h:\nupdate ${A} failed in 3 of 100: ${reason}\n`),
    );
    expect(await tide(api, [...verdictArgs(share, min), "--json"])).toEqual(
      success(
        verdictDocument({
          maxFailedShare: Number(share),
          minChecks: Number(min),
          result,
          failedChecks: 3,
          checks: 100,
        }),
      ),
    );
  });

  test("zero checks is not enough checks", async () => {
    const api = await fake();
    api.write(check({ running: B, failed: [C] }), 1000);
    const result = await tide(api, verdictArgs("0", "1"));
    expect(result).toEqual(
      success(
        `checks, not devices, last 24 h:\nupdate ${A} failed in 0 of 0: not enough checks, fewer than 1\n`,
      ),
    );
  });

  test("a check that runs the update and lists it as failed counts once", async () => {
    const api = await fake();
    api.write(check({ running: A, failed: [A] }), 50);
    api.write(check({ running: A }), 50);
    // Counted twice it would be 50 of 150, under 34%.
    expect((await tide(api, verdictArgs("49.99", "100"))).code).toBe(10);
    expect((await tide(api, verdictArgs("50", "100"))).code).toBe(0);
    expect((await tide(api, verdictArgs("0", "101"))).code).toBe(0);
  });

  test("only checks of the one update count, under the filters and the window", async () => {
    const api = await fake();
    api.write(check({ running: A }), 100);
    api.write(check({ running: A, failed: [C] }), 100);
    api.write(check({ running: C, failed: [A] }), 100);
    api.write(check({ running: B, failed: [C, A], channel: "beta" }), 100);
    api.write(check({ running: A, failed: [A] }), 100, 25);
    const counts = async (update: string, extra: string[] = []) =>
      JSON.parse(
        (await tide(api, [...verdictArgs("100", "1", update), "--json", ...extra])).stdout,
      ) as unknown;
    expect(await counts(A)).toMatchObject({ verdict: { failedChecks: 200, checks: 400 } });
    expect(await counts(B)).toMatchObject({ verdict: { failedChecks: 0, checks: 100 } });
    expect(await counts(C)).toMatchObject({ verdict: { failedChecks: 200, checks: 300 } });
    expect(await counts(A, ["--channel", "main"])).toMatchObject({
      verdict: { failedChecks: 100, checks: 300 },
    });
    expect(await counts(A, ["--window", "2d"])).toMatchObject({
      verdict: { failedChecks: 300, checks: 500 },
    });
  });

  test("the sample intervals decide it, not the rows", async () => {
    const bad = await fake();
    bad.write(check({ running: B, failed: [A] }), 90);
    for (let i = 0; i < 10; i++) bad.write(check({ running: A }), 1);
    expect((await tide(bad, verdictArgs("50", "100"))).code).toBe(10);
    const ok = await fake();
    ok.write(check({ running: A }), 90);
    for (let i = 0; i < 10; i++) ok.write(check({ running: B, failed: [A] }), 1);
    expect((await tide(ok, verdictArgs("50", "100"))).code).toBe(0);
    // 100 checks reach the minimum in 11 rows.
    expect((await tide(ok, verdictArgs("9", "100"))).code).toBe(10);
  });
});

describe("failures", () => {
  const reply = (data: unknown): SqlFault => ({
    reply: JSON.stringify({ meta: [], data, rows: 1, note: FAKE_BODY }),
  });
  const groups = (row: object) => reply([{ outcome: "failed", checks: "9", ...row }]);
  // A verdict, so that each case also shows a failure never reads as a bad update.
  const args = verdictArgs("0", "1");

  test.each<[string, SqlFault, number, string]>([
    ["a dropped connection", "drop", 3, "the SQL API could not be reached"],
    ...[401, 403, 404, 422, 429, 500, 503, 204].map(
      (status): [string, SqlFault, number, string] => [
        `a ${status}`,
        { status },
        4,
        `the SQL API answered ${status}`,
      ],
    ),
    ["an oversize body", "oversize", 5, "the SQL API's reply is over 1048576 bytes"],
    ["malformed JSON", { reply: `{"data":[${FAKE_BODY}` }, 5, "the SQL API's reply is not JSON"],
    [
      "a body that is not UTF-8",
      { reply: new Uint8Array([0x7b, 0xff, 0x7d]) },
      5,
      "the SQL API's reply is not JSON",
    ],
    ["no data", reply(undefined), 5, "the SQL API's reply has no data rows"],
    ["data that is no list", reply({}), 5, "the SQL API's reply has no data rows"],
    ["JSON null", { reply: "null" }, 5, "the SQL API's reply has no data rows"],
    [
      "a row that is no object",
      reply([FAKE_BODY]),
      5,
      "the SQL API's reply has a row without a valid outcome",
    ],
    [
      "a row without the grouped column",
      reply([{ checks: "9" }]),
      5,
      "the SQL API's reply has a row without a valid outcome",
    ],
    [
      "a value outside its grammar",
      groups({ outcome: FAKE_BODY }),
      5,
      "the SQL API's reply has a row without a valid outcome",
    ],
    ...[undefined, null, "", "many", "1e3", "0x9", "1.5", "-1", 1.5, -1, true, ["9"]].map(
      (checks): [string, SqlFault, number, string] => [
        `a count of ${JSON.stringify(checks)}`,
        groups({ checks }),
        5,
        "the SQL API's reply has a row whose checks is not a count",
      ],
    ),
    [
      "a count past 2^53",
      groups({ checks: "9007199254740993" }),
      5,
      "the SQL API's reply counts more checks than fit a number",
    ],
  ])("%s has its fixed code and text", async (_, fault, code, message) => {
    const api = await fake();
    api.fault(fault);
    const expected = failure(code, message);
    expect(await tide(api, args)).toEqual(expected);
    expect(await tide(api, [...args, "--json"])).toEqual(expected);
    expect(api.requests).toBe(2); // Nothing is retried.
  });

  test.each<SqlFault>(["silent", "stall"])("a %s server passes the deadline", async (fault) => {
    const api = await fake();
    api.fault(fault);
    expect(await tide(api, args, ENV, 100)).toEqual(
      failure(3, "the SQL API sent no whole reply within 100 ms"),
    );
  });

  test("a refused connection", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    expect(await tide({ origin: `http://127.0.0.1:${port}` }, args)).toEqual(
      failure(3, "the SQL API could not be reached"),
    );
  });

  test("a redirect is a status, and the token follows it nowhere", async () => {
    const api = await fake();
    const elsewhere = await fake();
    api.fault({
      redirect: `${elsewhere.origin}/client/v4/accounts/${FAKE_ACCOUNT}/analytics_engine/sql`,
    });
    expect(await tide(api, args)).toEqual(failure(4, "the SQL API answered 307"));
    expect(elsewhere.requests).toBe(0);
  });

  test.each([
    ["update_id", 3, 1],
    ["failed_ids", 5, 2],
    ["side", 6, 3],
  ])(
    "a report fails on a %s outside its grammar and prints nothing of earlier queries",
    async (alias, blob, queries) => {
      const api = await fake();
      api.write(check({ running: A, failed: [A] }), 1);
      const broken = check({ running: A });
      broken.blobs[blob] = FAKE_BODY;
      api.write(broken, 1);
      expect(await tide(api)).toEqual(
        failure(5, `the SQL API's reply has a row without a valid ${alias}`),
      );
      expect(api.sql).toHaveLength(queries);
    },
  );
});

describe("usage", () => {
  const NAME = "must be 1 to 64 of A-Z, a-z, 0-9, ., _, +, -, (, ) and :, and not . or ..";
  const WINDOW = "--window must be 1h to 2136h or 1d to 89d";
  const SHARE = "--max-failed-share must be a percentage from 0 to 100 in steps of 0.01";
  const MIN = "--min-checks must be a whole number from 1, of at most 15 digits";
  const TOGETHER = "--update, --max-failed-share and --min-checks go together";
  const METACHARACTERS = [
    "main' OR '1'='1",
    "main\\",
    "main`",
    'main"',
    "main;",
    "main\n",
    "ma in",
  ];

  test.each<[string, string[], string]>([
    [
      "an unknown flag",
      ["--endpoint", "http://127.0.0.1"],
      `unrecognised arguments; ${STATS_USAGE}`,
    ],
    ["a positional", ["main"], `unrecognised arguments; ${STATS_USAGE}`],
    ...["", "0h", "0d", "2137h", "90d", "24", "-1h", "1.5h", "1w", "1e3h", "24h'"].map(
      (window): [string, string[], string] => [
        `a window of ${JSON.stringify(window)}`,
        [`--window=${window}`],
        WINDOW,
      ],
    ),
    ...["", ".", "..", "a/b", "x".repeat(65), ...METACHARACTERS].flatMap(
      (name): [string, string[], string][] => [
        [`a channel ${JSON.stringify(name)}`, [`--channel=${name}`], `--channel ${NAME}`],
        [
          `a runtime ${JSON.stringify(name)}`,
          [`--runtime-version=${name}`],
          `--runtime-version ${NAME}`,
        ],
      ],
    ),
    ...["", "web", "ios' OR '1'='1"].map((platform): [string, string[], string] => [
      `a platform ${JSON.stringify(platform)}`,
      [`--platform=${platform}`],
      "--platform must be ios or android",
    ]),
    ...["", A.toUpperCase(), `${A}'`, `${A}\n`, "not-a-uuid"].map(
      (update): [string, string[], string] => [
        `an update ${JSON.stringify(update)}`,
        verdictArgs("5", "10", update),
        "--update must be a lowercase UUID",
      ],
    ),
    ...["", "-1", "100.01", "101", "5%", "0.001", "1e1", "NaN", "5'"].map(
      (share): [string, string[], string] => [
        `a share of ${JSON.stringify(share)}`,
        ["--update", A, `--max-failed-share=${share}`, "--min-checks", "10"],
        SHARE,
      ],
    ),
    ...["", "0", "-1", "1.5", "1e3", "1'", "1".repeat(16)].map(
      (min): [string, string[], string] => [
        `min-checks of ${JSON.stringify(min)}`,
        ["--update", A, "--max-failed-share", "5", `--min-checks=${min}`],
        MIN,
      ],
    ),
    ["the update alone", ["--update", A], TOGETHER],
    ["the share alone", ["--max-failed-share", "5"], TOGETHER],
    ["min-checks alone", ["--min-checks", "10"], TOGETHER],
    ["no update", ["--max-failed-share", "5", "--min-checks", "10"], TOGETHER],
    ["no share", ["--update", A, "--min-checks", "10"], TOGETHER],
    ["no min-checks", ["--update", A, "--max-failed-share", "5"], TOGETHER],
    [
      "--print-sql with --json",
      ["--print-sql", "--json"],
      "--print-sql and --json do not go together",
    ],
  ])("%s exits 2, sends nothing and prints no query", async (_, args, message) => {
    const api = await fake();
    for (const extra of [[], ["--json"], ["--print-sql"]]) {
      expect(await tide(api, [...args, ...extra])).toEqual(failure(2, message));
    }
    expect(api.requests).toBe(0);
  });

  const REQUIRED = "TIDE_ANALYTICS_ACCOUNT_ID and TIDE_ANALYTICS_TOKEN are required";
  const HEX = "TIDE_ANALYTICS_ACCOUNT_ID must be 32 lowercase hex digits";
  const PRINTABLE = "TIDE_ANALYTICS_TOKEN must be printable ASCII without whitespace";
  test.each<[string, Record<string, string>, string]>([
    ["no token", { TIDE_ANALYTICS_ACCOUNT_ID: FAKE_ACCOUNT }, REQUIRED],
    ["an empty token", { ...ENV, TIDE_ANALYTICS_TOKEN: "" }, REQUIRED],
    ["no account ID", { TIDE_ANALYTICS_TOKEN: FAKE_TOKEN }, REQUIRED],
    ["an empty account ID", { ...ENV, TIDE_ANALYTICS_ACCOUNT_ID: "" }, REQUIRED],
    ["a token with a newline", { ...ENV, TIDE_ANALYTICS_TOKEN: `${FAKE_TOKEN}\n` }, PRINTABLE],
    ["a token outside ASCII", { ...ENV, TIDE_ANALYTICS_TOKEN: `${FAKE_TOKEN}é` }, PRINTABLE],
    ...["a".repeat(31), "A".repeat(32), `${"a".repeat(30)}/.`, `../${"a".repeat(29)}`].map(
      (account): [string, Record<string, string>, string] => [
        `an account ID ${account}`,
        { ...ENV, TIDE_ANALYTICS_ACCOUNT_ID: account },
        HEX,
      ],
    ),
  ])("%s exits 2 and sends nothing", async (_, env, message) => {
    const api = await fake();
    for (const args of [[], ["--json"], verdictArgs("5", "10")]) {
      expect(await tide(api, args, env)).toEqual(failure(2, message));
    }
    expect(api.requests).toBe(0);
  });

  test.each(["1tide", "tide-manifest", "x".repeat(65), ...METACHARACTERS])(
    "a dataset %j exits 2, sends nothing and prints no query",
    async (dataset) => {
      const api = await fake();
      const env = { ...ENV, TIDE_ANALYTICS_DATASET: dataset };
      for (const args of [[], ["--print-sql"], verdictArgs("5", "10")]) {
        expect(await tide(api, args, env)).toEqual(
          failure(
            2,
            "TIDE_ANALYTICS_DATASET must be 1 to 64 letters, digits and _, not starting with a digit",
          ),
        );
      }
      expect(api.requests).toBe(0);
    },
  );

  test("the edges of each range are accepted", async () => {
    const api = await fake();
    api.write(check({ running: A }), 1);
    for (const window of ["1h", "2136h", "1d", "89d"]) {
      expect((await tide(api, ["--window", window])).code).toBe(0);
    }
    for (const share of ["0", "100", "0.01", "99.99"]) {
      expect((await tide(api, verdictArgs(share, "1"))).code).toBe(0);
    }
    expect((await tide(api, verdictArgs("5", "9".repeat(15)))).code).toBe(0);
  });
});

describe("--print-sql", () => {
  const FILTERS = [
    ...["--window", "7d", "--channel", "a+(b):c--d", "--runtime-version", "1.0.0"],
    ...["--platform", "android"],
  ];
  const filtered = (select: string, alias: string, condition = "") => `SELECT ${select}
FROM tide_staging
WHERE timestamp > NOW() - INTERVAL '168' HOUR
  AND index1 = 'a+(b):c--d'
  AND blob3 = '1.0.0'
  AND blob2 = 'android'${condition}
GROUP BY ${alias}
ORDER BY checks DESC, ${alias}
LIMIT 1001
FORMAT JSON`;
  const SUM = "SUM(_sample_interval) AS checks";
  const LISTED = `position('${A}' IN blob6) > 0`;

  test.each<[string, string[], string[]]>([
    [
      "the report",
      FILTERS,
      [
        filtered(`blob4 AS update_id, ${SUM}`, "update_id"),
        filtered(`blob6 AS failed_ids, ${SUM}`, "failed_ids", "\n  AND blob6 != ''"),
        filtered(`blob7 AS side, ${SUM}`, "side"),
      ],
    ],
    [
      "the verdict",
      [...FILTERS, ...verdictArgs("5", "10")],
      [
        filtered(
          `if(${LISTED}, 'failed', 'running') AS outcome, ${SUM}`,
          "outcome",
          `\n  AND (blob4 = '${A}' OR ${LISTED})`,
        ),
      ],
    ],
  ])(
    "%s: exactly the queries a run sends, with no token and no request",
    async (_, args, queries) => {
      const api = await fake();
      const env = { TIDE_ANALYTICS_DATASET: "tide_staging" };
      api.write(check({}), 1, 0, "tide_staging");
      expect(await tide(api, [...args, "--print-sql"], env)).toEqual(
        success(`${queries.join("\n\n")}\n`),
      );
      expect(api.requests).toBe(0);
      expect((await tide(api, args, { ...ENV, ...env })).code).toBe(0);
      expect(api.sql).toEqual(queries);
    },
  );

  test("the token and account ID are not read", async () => {
    const api = await fake();
    const env = { TIDE_ANALYTICS_ACCOUNT_ID: "x", TIDE_ANALYTICS_TOKEN: "\n" };
    expect(await tide(api, ["--print-sql"], env)).toEqual(await tide(api, ["--print-sql"], {}));
  });

  test("the bin prints the queries docs/design.md shows, over the dataset wrangler.jsonc names", async () => {
    const design = readFileSync(new URL("docs/design.md", ROOT), "utf8");
    const section = /\n### `tide stats`\n[\s\S]*?(?=\n##? |\n### |$)/.exec(design)?.[0] ?? "";
    const shown = [...section.matchAll(/```sql\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    const report = await run(MAIN, ["stats", "--print-sql"], {});
    const verdict = await run(
      MAIN,
      ["stats", ...verdictArgs("5", "500", ID(1)), "--print-sql"],
      {},
    );
    expect(report).toEqual(success(`${shown.slice(0, 3).join("\n\n")}\n`));
    expect(verdict).toEqual(success(`${shown.slice(3).join("\n\n")}\n`));
    const wrangler = readFileSync(new URL("packages/server/wrangler.jsonc", ROOT), "utf8");
    expect(report.stdout).toContain(`\nFROM ${/"dataset": "(\w+)"/.exec(wrangler)?.[1]}\n`);
  });
});
