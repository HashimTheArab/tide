import { parseArgs } from "node:util";

import {
  buildRollBackToEmbedded,
  contentKey,
  encodeMultipart,
  encodeStoredReply,
  expoSignature,
  replyKey,
} from "@tide-ota/protocol";

import type { Env, Writer } from "./keys.ts";
import type { Plan, PublishOptions } from "./publish.ts";
import { isKey } from "./bucket.ts";
import { openWriter } from "./keys.ts";
import { createdAtFloor } from "./pointer.ts";
import { PublishError, platformsOf, recordKey } from "./publish-record.ts";
import {
  commit,
  compose,
  execute,
  parsed,
  plan,
  readTargets,
  recordedKeys,
  storedContent,
} from "./publish.ts";

export const ROLLBACK_USAGE = `usage: tide rollback --embedded --channel <name> --runtime-version <version> [--platform ios|android]...
       tide rollback --to <updateId> [--to <updateId>]...`;
export const REPUBLISH_USAGE =
  "usage: tide republish <updateId>... [--channel <name>] [--runtime-version <version>]";

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
  return await run(env, options, () => {
    const { values } = parsed(ROLLBACK_USAGE, () =>
      parseArgs({
        args: [...args],
        options: {
          embedded: { type: "boolean" },
          to: { type: "string", multiple: true },
          channel: { type: "string" },
          "runtime-version": { type: "string" },
          platform: { type: "string", multiple: true },
        },
        strict: true,
        allowPositionals: false,
      }),
    );
    const { embedded, to, channel, platform } = values;
    const runtime = values["runtime-version"];
    if (embedded === true && to !== undefined) {
      throw new PublishError(`give --embedded or --to, not both; ${ROLLBACK_USAGE}`);
    }
    if (to !== undefined) {
      if (channel !== undefined || runtime !== undefined || platform !== undefined) {
        throw new PublishError(
          "--to rolls each update back on its own pointer: it takes no --channel, --runtime-version or --platform",
        );
      }
      return republishing(updateIds(to));
    }
    if (embedded !== true) throw new PublishError(`give --embedded or --to; ${ROLLBACK_USAGE}`);
    if (channel === undefined || runtime === undefined) {
      throw new PublishError(`--embedded needs --channel and --runtime-version; ${ROLLBACK_USAGE}`);
    }
    const keys = platformsOf(platform).map((p) => replyKey(channel, runtime, p));
    return rollingBack(keys);
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
  return await run(env, options, () => {
    const { values, positionals } = parsed(REPUBLISH_USAGE, () =>
      parseArgs({
        args: [...args],
        options: {
          channel: { type: "string" },
          "runtime-version": { type: "string" },
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
    // Refuses a bad channel or runtime before the writer opens.
    if (channel !== undefined) replyKey(channel, "1", "ios");
    if (runtime !== undefined) replyKey("main", runtime, "ios");
    return republishing(updateIds(positionals), channel, runtime);
  });
}

/** Parses, opens the writer for the shipped builds' identity, prepares, then commits. */
async function run(env: Env, options: PublishOptions, parse: () => Prepare): Promise<0 | 1 | 2> {
  const { now = Date.now } = options;
  return await execute(options, async () => {
    const prepare = parse();
    const writer = await openWriter(env, { now });
    const ready = await prepare(writer, now);
    return () => commit(ready, options.out);
  });
}

/** Returns the IDs, each a lowercase UUID, given once. */
function updateIds(ids: readonly string[]): readonly string[] {
  for (const [i, id] of ids.entries()) {
    if (!isKey(recordKey(id))) throw new PublishError("an update ID is not a lowercase UUID");
    if (ids.indexOf(id) !== i) throw new PublishError(`update ID ${id} is given twice`);
  }
  return ids;
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
    return await plan(writer, checkCertificate, [], pointers);
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
    const { records: retained } = await recordedKeys(bucket, { wanted: ids.map(recordKey) });
    const stored = await storedContent(bucket);
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
      const c = await compose(writer, { ...draft, channel: target }, createdAt, { key, previous });
      records.push(...c.records);
      pointers.push(c.pointer);
    }
    return await plan(writer, checkCertificate, records, pointers);
  };
}
