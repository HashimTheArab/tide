import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  buildRollBackToEmbedded,
  contentKey,
  encodeMultipart,
  encodeStoredReply,
  expoSignature,
  replyKey,
} from "@tide/protocol";

import type { Env, Writer } from "./keys.ts";
import type { Plan, PublishOptions } from "./publish.ts";
import { isKey } from "./bucket.ts";
import { openWriter } from "./keys.ts";
import { createdAtFloor } from "./pointer.ts";
import { expoEnv, expoJson } from "./publish-export.ts";
import { PublishError, recordKey } from "./publish-record.ts";
import {
  commit,
  compose,
  finish,
  platformsOf,
  readTargets,
  recordedKeys,
  report,
  storedContent,
} from "./publish.ts";

export const ROLLBACK_USAGE = `usage: tide rollback --embedded --channel <name> --runtime-version <version> [--platform ios|android]... [--project-root <dir>]
       tide rollback --to <updateId> [--to <updateId>]... [--project-root <dir>]`;
export const REPUBLISH_USAGE =
  "usage: tide republish <updateId>... [--channel <name>] [--runtime-version <version>] [--project-root <dir>]";

/** What a write command does once its arguments are parsed, given the opened writer. */
type Prepare = (writer: Writer, now: () => number) => Promise<Plan>;

/**
 * Rolls pointers back: `--embedded` serves a signed `rollBackToEmbedded`, `--to` republishes each update onto its own
 * pointer. Exit codes as publish: 0 every pointer written, 2 refused before any write, 1 failed after writes began.
 */
export async function rollback(
  args: readonly string[],
  env: Env,
  options: PublishOptions,
): Promise<0 | 1 | 2> {
  return await run(env, options, (cwd) => {
    const { values } = parsed(ROLLBACK_USAGE, () =>
      parseArgs({
        args: [...args],
        options: {
          embedded: { type: "boolean" },
          to: { type: "string", multiple: true },
          channel: { type: "string" },
          "runtime-version": { type: "string" },
          platform: { type: "string", multiple: true },
          "project-root": { type: "string" },
        },
        strict: true,
        allowPositionals: false,
      }),
    );
    const { embedded, to, channel, platform } = values;
    const runtime = values["runtime-version"];
    const projectRoot = resolve(cwd, values["project-root"] ?? ".");
    if (embedded === true && to !== undefined) {
      throw new PublishError(`give --embedded or --to, not both; ${ROLLBACK_USAGE}`);
    }
    if (to !== undefined) {
      if (channel !== undefined || runtime !== undefined || platform !== undefined) {
        throw new PublishError(
          "--to rolls each update back on its own pointer: it takes no --channel, --runtime-version or --platform",
        );
      }
      return { projectRoot, prepare: republishing(updateIds(to)) };
    }
    if (embedded !== true) throw new PublishError(`give --embedded or --to; ${ROLLBACK_USAGE}`);
    if (channel === undefined || runtime === undefined) {
      throw new PublishError(`--embedded needs --channel and --runtime-version; ${ROLLBACK_USAGE}`);
    }
    const keys = platformsOf(platform).map((p) => replyKey(channel, runtime, p));
    return { projectRoot, prepare: rollingBack(keys) };
  });
}

/**
 * Republishes each stored update under a new ID with a fresh `createdAt`, onto `--channel` or its own channel. Exit
 * codes as publish.
 */
export async function republish(
  args: readonly string[],
  env: Env,
  options: PublishOptions,
): Promise<0 | 1 | 2> {
  return await run(env, options, (cwd) => {
    const { values, positionals } = parsed(REPUBLISH_USAGE, () =>
      parseArgs({
        args: [...args],
        options: {
          channel: { type: "string" },
          "runtime-version": { type: "string" },
          "project-root": { type: "string" },
        },
        strict: true,
        allowPositionals: true,
      }),
    );
    if (positionals.length === 0) {
      throw new PublishError(`give at least one update ID; ${REPUBLISH_USAGE}`);
    }
    const { channel } = values;
    const runtime = values["runtime-version"];
    // Refuses a bad channel or runtime before Expo runs.
    if (channel !== undefined) replyKey(channel, "1", "ios");
    if (runtime !== undefined) replyKey("main", runtime, "ios");
    return {
      projectRoot: resolve(cwd, values["project-root"] ?? "."),
      prepare: republishing(updateIds(positionals), channel, runtime),
    };
  });
}

/** Parses before Expo runs, opens the writer from the app config, prepares, then commits. */
async function run(
  env: Env,
  options: PublishOptions,
  parse: (cwd: string) => { readonly projectRoot: string; readonly prepare: Prepare },
): Promise<0 | 1 | 2> {
  const { now = Date.now, cwd = process.cwd() } = options;
  let plan;
  try {
    const { projectRoot, prepare } = parse(cwd);
    // The app config is project code, so it runs without TIDE_ variables or dotenv files.
    const config = await expoJson(projectRoot, expoEnv(env), "expo", ["config", "--json"]);
    plan = await prepare(await openWriter(env, { projectRoot, config }, { now }), now);
  } catch (e) {
    return report(e, options, 2);
  }
  try {
    await commit(plan, options.out);
  } catch (e) {
    return report(e, options, 1);
  }
  return 0;
}

/** Returns `parse()`, turning parseArgs' own error into a usage refusal. */
function parsed<T>(usage: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new PublishError(`unrecognised arguments; ${usage}`);
  }
}

/** Returns the IDs, each a lowercase UUID, given once. */
function updateIds(ids: readonly string[]): string[] {
  for (const [i, id] of ids.entries()) {
    if (!isKey(recordKey(id))) throw new PublishError("an update ID is not a lowercase UUID");
    if (ids.indexOf(id) !== i) throw new PublishError(`update ID ${id} is given twice`);
  }
  return [...ids];
}

/** Signs a `rollBackToEmbedded` for each existing pointer, committed after the time it replaces. */
function rollingBack(keys: readonly string[]): Prepare {
  return async (writer, now) => {
    const { targets, local, checkCertificate } = await readTargets(
      writer,
      keys.map((key) => ({ key })),
      now,
    );
    const pointers = [];
    for (const { key, previous } of targets) {
      // A typo in the channel or runtime must not "succeed" while the bad update keeps serving.
      if (previous.etag === undefined) {
        throw new PublishError(`${key} does not exist: there is nothing to roll back`);
      }
      const commitTime = new Date(createdAtFloor(local, previous));
      const body = buildRollBackToEmbedded({ commitTime });
      const signature = await expoSignature(body, writer.signer);
      const multipart = encodeMultipart([{ name: "directive", body, signature }]);
      pointers.push({
        key,
        previous,
        reply: encodeStoredReply({ kind: "rollBackToEmbedded", ...multipart }),
        line: `${key} - ${commitTime.toISOString()}`,
      });
    }
    return { ...(await finish(writer, checkCertificate)), records: [], pointers };
  };
}

/**
 * Republishes each update's stored record under a new ID onto `channel`, or its own. Its bundle and assets must be
 * stored already; nothing is uploaded.
 */
function republishing(ids: readonly string[], channel?: string, runtime?: string): Prepare {
  return async (writer, now) => {
    const { bucket } = writer;
    // Every retained record decodes and agrees on asset keys, the source's included, as a publish requires.
    const { records: retained } = await recordedKeys(bucket);
    const stored = new Set(await storedContent(bucket));
    const sources = [];
    for (const id of ids) {
      const record = retained.get(recordKey(id));
      if (record === undefined) throw new PublishError(`no release record for update ${id}`);
      if (runtime !== undefined && record.runtimeVersion !== runtime) {
        throw new PublishError(
          `update ${id} was built for another runtime version than --runtime-version`,
        );
      }
      const target = channel ?? record.channel;
      const key = replyKey(target, record.runtimeVersion, record.platform);
      const twin = sources.find((s) => s.key === key);
      // Two writes over one read ETag would fail the run against its own pointer.
      if (twin !== undefined) {
        throw new PublishError(`updates ${twin.record.updateId} and ${id} both target ${key}`);
      }
      const referenced = [
        `bundles/${contentKey(record.launchAsset.hash)}`,
        ...record.assets.map((a) => `assets/${contentKey(a.hash)}`),
      ];
      const missing = referenced.find((k) => !stored.has(k));
      if (missing !== undefined) {
        throw new PublishError(`update ${id} references ${missing}, which is missing`);
      }
      sources.push({ key, record, channel: target });
    }

    const { targets, local, checkCertificate } = await readTargets(writer, sources, now);
    const records = [];
    const pointers = [];
    for (const { key, record, channel: target, previous } of targets) {
      // Newer than the code it copies too, even when that was stamped by a clock ahead of this one.
      const createdAt = Math.max(createdAtFloor(local, previous), Date.parse(record.createdAt) + 1);
      const { updateId: _, createdAt: __, ...draft } = record;
      const c = await compose(writer, { ...draft, channel: target }, createdAt);
      records.push([recordKey(c.updateId), c.record] as const);
      pointers.push({ key, previous, reply: c.reply, line: c.line(key) });
    }
    return { ...(await finish(writer, checkCertificate)), records, pointers };
  };
}
