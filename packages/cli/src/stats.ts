import { parseArgs } from "node:util";

import { UUID, readLimited } from "@tide-ota/protocol";

import type { Env } from "./keys.ts";
import { jsonDocument } from "./json.ts";
import { member, read } from "./keys.ts";
import { PROBE_EXIT } from "./probe.ts";
import { targetProblem } from "./publish-record.ts";

/** Exit codes; no other Tide command exits with `badUpdate`'s. */
const STATS_EXIT = {
  usage: PROBE_EXIT.usage,
  unreachable: PROBE_EXIT.unreachable,
  status: PROBE_EXIT.status,
  unparseable: PROBE_EXIT.unparseable,
  badUpdate: 10,
} as const;

export const STATS_USAGE =
  "usage: tide stats [--window <n>h|<n>d] [--channel <name>] [--runtime-version <version>] [--platform ios|android] [--update <updateId> --max-failed-share <percent> --min-checks <n>] [--print-sql]";

const TOKEN = "TIDE_ANALYTICS_TOKEN";
const ACCOUNT = "TIDE_ANALYTICS_ACCOUNT_ID";
const DATASET = "TIDE_ANALYTICS_DATASET";
const DEFAULT_DATASET = "tide_manifest";
const DEFAULT_HOURS = 24;
const MAX_HOURS = 89 * 24; // The shortest three calendar months, Analytics Engine's retention.
const MAX_ROWS = 1000;
/** 1,001 rows of at most 184 bytes of failed IDs and a count are under 400 KB. */
const MAX_REPLY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const SCHEMA = 1;

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const BEARER = /^[\x21-\x7e]{1,1024}$/;
const WINDOW = /^([1-9]\d{0,3})([hd])$/;
const SHARE = /^(?:(?:0|[1-9]\d?)(?:\.\d{1,2})?|100)$/;
const MIN_CHECKS = /^[1-9]\d{0,14}$/; // Below 2^53.
const COUNT = /^(?:0|[1-9]\d*)$/;

// The values the Worker stores in each grouped column, empty when a point has none.
const ID = UUID.source.slice(1, -1);
const UPDATE_ID = new RegExp(`^(?:${ID})?$`);
const FAILED_IDS = new RegExp(`^${ID}(?:,${ID})*$`);
const SIDE = /^(?:new|earlier|none)?$/;
const OUTCOME = /^(?:failed|running)$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A run without a result, so never a bad update. Its message is fixed text and statuses, never a value or a body. */
class StatsFailure extends Error {
  readonly failure: Exclude<keyof typeof STATS_EXIT, "badUpdate">;

  constructor(failure: StatsFailure["failure"], message: string) {
    super(message);
    this.name = "StatsFailure";
    this.failure = failure;
  }
}

const usage = (message: string) => new StatsFailure("usage", message);

interface Threshold {
  readonly updateId: string;
  readonly maxFailedShare: number; // A percentage, 0 to 100 in steps of 0.01.
  readonly minChecks: number;
}

/** Weighted checks of one group; a null name is a value its checks did not have. */
interface Count {
  readonly name: string | null;
  readonly checks: number;
}

interface Counts {
  readonly truncated: boolean;
  readonly counts: readonly Count[];
}

/** Counts checks per value of one SQL expression; `values` is what a group's value may be. */
type CountChecks = (
  value: string,
  alias: string,
  values: RegExp,
  condition?: string,
) => Promise<Counts>;

interface Result {
  readonly document: object; // Only the mode's own fields.
  readonly lines: readonly string[];
  readonly bad: boolean;
}

/**
 * Reports update checks from the Worker's Analytics Engine dataset, or the verdict on one update. Returns 0, or
 * `STATS_EXIT`: `badUpdate` only for a verdict over the share, and any failure's own code with nothing on stdout.
 */
export async function stats(
  args: readonly string[],
  env: Env,
  io: { readonly out: (line: string) => void; readonly err: (line: string) => void },
  // The origin is fixed so that the token goes nowhere else; only a test replaces it.
  options: { readonly origin?: string; readonly timeoutMs?: number } = {},
): Promise<number> {
  try {
    const { hours, dataset, filters, threshold, api, json } = configure(args, env);
    const printed: string[] = [];
    const count: CountChecks = async (value, alias, values, condition) => {
      const sql = `SELECT ${value} AS ${alias}, SUM(_sample_interval) AS checks
FROM ${dataset}
WHERE ${[...filters, ...(condition === undefined ? [] : [condition])].join("\n  AND ")}
GROUP BY ${alias}
ORDER BY checks DESC, ${alias}
LIMIT ${MAX_ROWS + 1}
FORMAT JSON`;
      if (api === undefined) {
        printed.push(sql);
        return { truncated: false, counts: [] };
      }
      const url = `${options.origin ?? "https://api.cloudflare.com"}${api.path}`;
      const body = await send(url, api.token, sql, options.timeoutMs ?? TIMEOUT_MS);
      return countsOf(body, alias, values);
    };
    const { document, lines, bad } = await (threshold === undefined
      ? report(count)
      : verdict(count, threshold));
    // Nothing is printed until every query has an answer.
    if (api === undefined) {
      io.out(printed.join("\n\n"));
      return 0;
    }
    if (json) {
      io.out(
        jsonDocument({
          schema: SCHEMA,
          windowHours: hours,
          currentUpdates: null,
          failedUpdates: null,
          rolloutSides: null,
          verdict: null,
          ...document,
        }),
      );
    } else for (const line of [`checks, not devices, last ${hours} h:`, ...lines]) io.out(line);
    return bad ? STATS_EXIT.badUpdate : 0;
  } catch (e) {
    if (!(e instanceof StatsFailure)) throw e;
    io.err(`tide: ${e.message}`);
    return STATS_EXIT[e.failure];
  }
}

/** Checks per current update, per failed update and per rollout side. */
async function report(count: CountChecks): Promise<Result> {
  const current = await count("blob4", "update_id", UPDATE_ID);
  const failed = perFailedId(await count("blob6", "failed_ids", FAILED_IDS, "blob6 != ''"));
  const side = await count("blob7", "side", SIDE);
  const named = (field: string, { truncated, counts }: Counts) => ({
    truncated,
    counts: counts.map(({ name, checks }) => ({ [field]: name, checks })),
  });
  return {
    document: {
      currentUpdates: named("updateId", current),
      failedUpdates: named("updateId", failed),
      rolloutSides: named("side", side),
    },
    lines: [
      ...section("current update", current, "lower counts are left out"),
      ...section("failed update", failed, "every count is a lower bound"),
      ...section("rollout side", side, "lower counts are left out"),
    ],
    bad: false,
  };
}

/** Counts each group's checks once for every update its failed IDs name. */
function perFailedId({ truncated, counts }: Counts): Counts {
  const totals = new Map<string, number>();
  for (const { name, checks } of counts) {
    // A client may list an ID twice.
    for (const id of new Set(name?.split(","))) totals.set(id, (totals.get(id) ?? 0) + checks);
  }
  return {
    truncated,
    counts: [...totals]
      .map(([name, checks]) => ({ name, checks }))
      .sort((a, b) => b.checks - a.checks || (a.name < b.name ? -1 : 1)),
  };
}

function section(label: string, { truncated, counts }: Counts, missing: string): string[] {
  return [
    ...counts.map(({ name, checks }) => `${label} ${name ?? "-"} ${checks}`),
    ...(counts.length === 0 ? [`${label}: no checks`] : []),
    ...(truncated ? [`${label}: truncated at ${MAX_ROWS} rows, so ${missing}`] : []),
  ];
}

/** Whether too large a share of the checks that run the update, or list it as failed, list it as failed. */
async function verdict(
  count: CountChecks,
  { updateId, maxFailedShare, minChecks }: Threshold,
): Promise<Result> {
  const listed = `position('${updateId}' IN blob6) > 0`;
  // One group per check, so a check that both runs and lists the update counts once.
  const { counts } = await count(
    `if(${listed}, 'failed', 'running')`,
    "outcome",
    OUTCOME,
    `(blob4 = '${updateId}' OR ${listed})`,
  );
  const sum = (rows: readonly Count[]) => rows.reduce((n, row) => n + row.checks, 0);
  const checks = sum(counts);
  const failedChecks = sum(counts.filter((row) => row.name === "failed"));
  // Exact: hundredths of a percent and bigint products.
  const over =
    BigInt(failedChecks) * 10_000n > BigInt(Math.round(maxFailedShare * 100)) * BigInt(checks);
  const result = checks < minChecks ? "notEnoughChecks" : over ? "bad" : "ok";
  const reason = {
    notEnoughChecks: `not enough checks, fewer than ${minChecks}`,
    bad: `bad, over ${maxFailedShare}%`,
    ok: `ok, not over ${maxFailedShare}%`,
  }[result];
  return {
    document: {
      verdict: { updateId, maxFailedShare, minChecks, result, failedChecks, checks },
    },
    lines: [`update ${updateId} failed in ${failedChecks} of ${checks}: ${reason}`],
    bad: result === "bad",
  };
}

function configure(args: readonly string[], env: Env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        window: { type: "string" },
        channel: { type: "string" },
        "runtime-version": { type: "string" },
        platform: { type: "string" },
        update: { type: "string" },
        "max-failed-share": { type: "string" },
        "min-checks": { type: "string" },
        "print-sql": { type: "boolean" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw usage(`unrecognised arguments; ${STATS_USAGE}`);
  }
  // Everything below that reaches a query matches a grammar without quotes, backslashes or whitespace.
  const [, length, unit] = WINDOW.exec(values.window ?? `${DEFAULT_HOURS}h`) ?? [];
  const hours = Number(length) * (unit === "d" ? 24 : 1);
  if (!(hours <= MAX_HOURS)) {
    throw usage(`--window must be 1h to ${MAX_HOURS}h or 1d to ${MAX_HOURS / 24}d`);
  }
  const { channel, platform } = values;
  const runtime = values["runtime-version"];
  const problem = targetProblem(channel ?? "any", runtime ?? "any", platform ?? "ios");
  if (problem !== undefined) throw usage(problem);
  const threshold = thresholdOf(values.update, values["max-failed-share"], values["min-checks"]);
  const printSql = values["print-sql"] ?? false;
  const json = values.json ?? false;
  if (printSql && json) throw usage("--print-sql and --json do not go together");
  const dataset = read(env, DATASET) ?? DEFAULT_DATASET;
  if (!SQL_IDENTIFIER.test(dataset)) {
    throw usage(`${DATASET} must be 1 to 64 letters, digits and _, not starting with a digit`);
  }

  return {
    hours,
    dataset,
    filters: [
      `timestamp > NOW() - INTERVAL '${hours}' HOUR`,
      ...(channel === undefined ? [] : [`index1 = '${channel}'`]),
      ...(runtime === undefined ? [] : [`blob3 = '${runtime}'`]),
      ...(platform === undefined ? [] : [`blob2 = '${platform}'`]),
    ],
    threshold,
    api: printSql ? undefined : apiOf(env),
    json,
  };
}

/** Returns the verdict's three flags, given together or not at all. */
function thresholdOf(
  updateId: string | undefined,
  share: string | undefined,
  minChecks: string | undefined,
): Threshold | undefined {
  if (updateId === undefined && share === undefined && minChecks === undefined) return undefined;
  if (updateId === undefined || share === undefined || minChecks === undefined) {
    throw usage("--update, --max-failed-share and --min-checks go together");
  }
  if (!UUID.test(updateId)) throw usage("--update must be a lowercase UUID");
  if (!SHARE.test(share)) {
    throw usage("--max-failed-share must be a percentage from 0 to 100 in steps of 0.01");
  }
  if (!MIN_CHECKS.test(minChecks)) {
    throw usage("--min-checks must be a whole number from 1, of at most 15 digits");
  }
  return { updateId, maxFailedShare: Number(share), minChecks: Number(minChecks) };
}

/** Returns the account's SQL API path and the token; no message echoes either. */
function apiOf(env: Env): { readonly path: string; readonly token: string } {
  const account = read(env, ACCOUNT);
  const token = read(env, TOKEN);
  if (account === undefined || token === undefined) {
    throw usage(`${ACCOUNT} and ${TOKEN} are required`);
  }
  if (!ACCOUNT_ID.test(account)) {
    throw usage(`${ACCOUNT} must be 32 lowercase hex digits`);
  }
  if (!BEARER.test(token)) {
    throw usage(`${TOKEN} must be printable ASCII without whitespace`);
  }
  return { path: `/client/v4/accounts/${account}/analytics_engine/sql`, token };
}

/** Sends one query under a deadline that covers its reply's body, and returns that body. */
async function send(url: string, token: string, sql: string, timeoutMs: number) {
  const signal = AbortSignal.timeout(timeoutMs);
  const unreachable = () =>
    new StatsFailure(
      "unreachable",
      signal.aborted
        ? `the SQL API sent no whole reply within ${timeoutMs} ms`
        : "the SQL API could not be reached",
    );
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: sql,
      redirect: "manual", // A 3xx is then a status, and the token follows it nowhere.
      signal,
    });
  } catch {
    // The caught error is dropped: its text can quote the peer.
    throw unreachable();
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new StatsFailure("status", `the SQL API answered ${res.status}`);
  }
  let body;
  try {
    body = await readLimited(res, MAX_REPLY_BYTES);
  } catch {
    throw unreachable();
  }
  if (body === undefined) {
    throw new StatsFailure("unparseable", `the SQL API's reply is over ${MAX_REPLY_BYTES} bytes`);
  }
  return body;
}

/** Reads a `FORMAT JSON` reply to a query that asks for one row more than is kept. */
function countsOf(body: Uint8Array, alias: string, values: RegExp): Counts {
  const unparseable = (problem: string) =>
    new StatsFailure("unparseable", `the SQL API's reply ${problem}`);
  let data: unknown;
  try {
    data = member(JSON.parse(utf8.decode(body)), "data");
  } catch {
    throw unparseable("is not JSON");
  }
  if (!Array.isArray(data)) throw unparseable("has no data rows");
  const counts = data.map((row: unknown): Count => {
    const name = member(row, alias);
    const raw = member(row, "checks"); // A 64-bit integer, sent as a string.
    const checks = typeof raw === "string" && COUNT.test(raw) ? Number(raw) : raw;
    if (typeof name !== "string" || !values.test(name)) {
      throw unparseable(`has a row without a valid ${alias}`);
    }
    if (typeof checks !== "number" || !Number.isInteger(checks) || checks < 0) {
      throw unparseable("has a row whose checks is not a count");
    }
    return { name: name === "" ? null : name, checks };
  });
  // A repeated group would count its checks twice.
  if (new Set(counts.map(({ name }) => name)).size !== counts.length) {
    throw unparseable(`has two rows for one ${alias}`);
  }
  // No sum of a reply's rows is larger, so every count reported is exact.
  if (!Number.isSafeInteger(counts.reduce((n, row) => n + row.checks, 0))) {
    throw unparseable("counts more checks than fit a number");
  }
  return { truncated: counts.length > MAX_ROWS, counts: counts.slice(0, MAX_ROWS) };
}
