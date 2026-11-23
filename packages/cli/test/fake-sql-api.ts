import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { ManifestPoint } from "../../server/src/core/analytics.ts";

export const FAKE_ACCOUNT = "a".repeat(32);
export const FAKE_TOKEN = "tide-fake-analytics-token";
/** Text every reply but a successful one holds, so a test can see that none of it is printed. */
export const FAKE_BODY = "text only the SQL API's reply holds";

/** How every later query is answered, after the request checks pass. */
export type SqlFault =
  | { readonly status: number }
  | { readonly reply: string | Uint8Array } // 200 with this body
  | { readonly redirect: string } // 307 to this URL
  | "drop" // The connection closes with no reply
  | "silent" // No reply
  | "stall" // 200 headers flushed, then no body
  | "oversize"; // 200 with a body longer than any reply to Tide's queries

export interface FakeSqlApi {
  readonly origin: string;
  /** Every request that reached the fake, including a refused one. */
  readonly requests: number;
  /** The body of every request that passed the checks, in order. */
  readonly sql: readonly string[];
  /** Stores a point `hoursAgo`, standing for `interval` checks, in `dataset`. */
  write(point: ManifestPoint, interval: number, hoursAgo?: number, dataset?: string): void;
  /** Sends counts as JSON numbers instead of the strings ClickHouse's 64-bit integers are sent as. */
  numbers(): void;
  fault(fault: SqlFault): void;
  close(): Promise<void>;
}

/**
 * Starts a fake of Cloudflare's Analytics Engine SQL API on 127.0.0.1. It runs the SQL it is sent over the stored
 * points in SQLite, rewriting only the dialect's `position`, `NOW() - INTERVAL` and `FORMAT JSON`, so a query that
 * counts rows or reads the wrong column gets the wrong answer.
 */
export async function startFakeSqlApi(): Promise<FakeSqlApi> {
  const db = new DatabaseSync(":memory:");
  const datasets = new Set<string>();
  const sql: string[] = [];
  let requests = 0;
  let strings = true;
  let fault: SqlFault | undefined;

  const server = createServer((req, res) => {
    void (async () => {
      requests++;
      let body = "";
      for await (const chunk of req.setEncoding("utf8")) body += chunk as string;
      if (req.method !== "POST") return refuse(res, 405);
      if (req.url !== `/client/v4/accounts/${FAKE_ACCOUNT}/analytics_engine/sql`) {
        return refuse(res, 404);
      }
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return refuse(res, 401);
      sql.push(body);
      if (fault === "drop") return void req.socket.destroy();
      if (fault === "silent") return;
      if (fault === "stall") return res.writeHead(200).flushHeaders();
      if (fault === "oversize") return void res.end(`{"data":[]}${" ".repeat(1024 * 1024)}`);
      if (fault === undefined) return answer(res, body);
      if ("redirect" in fault) {
        return void res.writeHead(307, { location: fault.redirect }).end(FAKE_BODY);
      }
      if ("status" in fault) return refuse(res, fault.status);
      res.writeHead(200).end(fault.reply);
    })();
  });

  const answer = (res: ServerResponse, query: string) => {
    let data;
    try {
      const statement = query
        .replace(/\nFORMAT JSON$/, "")
        .replace(/NOW\(\) - INTERVAL '(\d+)' HOUR/, "unixepoch() - $1 * 3600")
        .replace(/position\(('[^']*') IN (\w+)\)/g, "instr($2, $1)");
      if (!query.endsWith("\nFORMAT JSON")) throw new Error("not FORMAT JSON");
      data = db.prepare(statement).all();
    } catch {
      return refuse(res, 422);
    }
    const rows = data.map((row) => (strings ? { ...row, checks: String(row.checks) } : { ...row }));
    const meta = Object.keys(rows[0] ?? {}).map((name) => ({
      name,
      type: name === "checks" ? "UInt64" : "String",
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ meta, data: rows, rows: rows.length }));
  };

  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const write: FakeSqlApi["write"] = (
    { indexes, blobs, doubles },
    interval,
    hoursAgo = 0,
    dataset = "tide_manifest",
  ) => {
    const columns = (name: string, count: number, type: string) =>
      Array.from({ length: count }, (_, i) => `${name}${i + 1} ${type}`);
    if (!datasets.has(dataset)) {
      datasets.add(dataset);
      db.exec(
        `CREATE TABLE ${dataset} (timestamp INTEGER, _sample_interval INTEGER, index1 TEXT, ${[
          ...columns("blob", 20, "TEXT DEFAULT ''"),
          ...columns("double", 20, "REAL DEFAULT 0"),
        ].join(", ")})`,
      );
    }
    const row: Record<string, string | number> = {
      timestamp: Math.floor(Date.now() / 1000) - hoursAgo * 3600,
      _sample_interval: interval,
      index1: indexes[0],
    };
    for (const [i, blob] of blobs.entries()) row[`blob${i + 1}`] = blob;
    for (const [i, double] of doubles.entries()) row[`double${i + 1}`] = double;
    const names = Object.keys(row);
    db.prepare(
      `INSERT INTO ${dataset} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ).run(...Object.values(row));
  };

  return {
    origin: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    sql,
    write,
    numbers: () => {
      strings = false;
    },
    fault: (f) => {
      fault = f;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

function refuse(res: ServerResponse, status: number): void {
  res.writeHead(status).end(FAKE_BODY);
}
