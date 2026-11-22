import { parseArgs } from "node:util";

import type { Rollout } from "@tide-ota/protocol";
import { NO_UPDATE_KEY, ProtocolError, encodeRollout, replyKey } from "@tide-ota/protocol";

import type { Env, Identity, Live, NoUpdate, Writer } from "./keys.ts";
import type { PointerState } from "./pointer.ts";
import type { DraftRecord, PointerWrite, PublishOptions } from "./publish.ts";
import type { Side } from "./status.ts";
import {
  buildIdentity,
  byBothClocks,
  checkCopied,
  checkLive,
  sameBytes,
  servingBucket,
} from "./keys.ts";
import { readPointer, writePointer } from "./pointer.ts";
import {
  PublishError,
  encodeRecord,
  platformsOf,
  readReleaseRecord,
  recordKey,
} from "./publish-record.ts";
import { execute, parsed } from "./publish.ts";
import { bucketFromEnv } from "./storage.ts";

export const ROLLOUT_USAGE =
  "usage: tide rollout <percent>|complete|revert --channel <name> --runtime-version <version> [--platform ios|android]...";

// 0 and 100 are spelled revert and complete.
const PERCENT = /^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/;

/** Returns `value` as a percentage from 0.01 to 99.99 in steps of 0.01; `name` labels the refusal. */
export function percentOf(value: string, name: string): number {
  const percent = Number(value);
  if (!PERCENT.test(value) || percent === 0) {
    throw new PublishError(`${name} must be a percentage from 0.01 to 99.99 in steps of 0.01`);
  }
  return percent;
}

/**
 * Moves each existing rollout to a higher percentage, to 100% (`complete`) or to 0% (`revert`), copying both stored
 * bodies byte for byte; nothing is signed. In chain mode each body the move leaves reachable is checked by both
 * clocks for every target, then again just before its PUT. Exit codes as publish: 0 every rollout at its goal, 2
 * refused before any write, 1 failed after writes began.
 */
export async function rollout(
  args: readonly string[],
  env: Env,
  options: PublishOptions,
): Promise<0 | 1 | 2> {
  const { now = Date.now, out } = options;
  return await execute(options, async () => {
    const { goal, keys } = parse(args);
    const identity = await buildIdentity(env, now());
    const bucket = bucketFromEnv(env);
    // So a rollout's absent earlier reply always has the stored reply/no-update to serve.
    const fallback = await servingBucket(
      bucket,
      identity,
      "reply/no-update is absent: tide publish, republish or rollback writes it",
    );
    // Direct mode makes no request here: the pinned certificate's validity covers every body.
    const check = async (live: readonly Live[]) => {
      if (identity.chain) await byBothClocks(bucket, now, (at) => checkLive(identity, live, at));
    };
    const writes: PointerWrite[] = [];
    for (const key of keys) {
      const previous = await readPointer(bucket, key);
      const { reply, sides = [] } = previous;
      if (reply === undefined) throw new PublishError(`${key} does not exist: there is no rollout`);
      if (reply.kind !== "rollout") throw new PublishError(`${key} holds no rollout`);
      if (reply.percent !== goal) forward(key, reply.percent, goal);
      await checkCopied(key, sides, identity);
      const live = reply.percent === goal ? [] : reachable(key, goal, sides, fallback);
      await check(live);
      writes.push({
        key,
        previous,
        // Encoded here, so a record over the size limit refuses before any write.
        reply: reply.percent === goal ? undefined : rolloutRecord(key, { ...reply, percent: goal }),
        line: `${key} ${reply.new.updateId} ${goal}`,
        live,
      });
    }
    // The first PUT's own check, after every other target was read, so its expiry meanwhile is still a refusal.
    const first = writes.find((w) => w.reply !== undefined);
    if (first !== undefined) await check(first.live ?? []);
    return async () => {
      for (const w of writes) {
        if (w.reply !== undefined) {
          if (w !== first) await check(w.live ?? []);
          await writePointer(bucket, w.key, w.reply, w.previous);
        }
        out(w.line);
      }
    };
  });
}

/**
 * Returns the bodies a rollout at `key` serves at `goal`: its new reply above 0%, and below 100% its earlier reply,
 * or `reply/no-update` when it has none.
 */
function reachable(
  key: string,
  goal: number,
  [next, earlier]: readonly Side[],
  fallback: NoUpdate,
): Live[] {
  const live: Live[] = [];
  if (goal > 0 && next !== undefined) live.push({ label: `${key}'s new reply`, side: next });
  if (goal < 100) {
    live.push(
      earlier === undefined
        ? { label: NO_UPDATE_KEY, side: fallback.side }
        : { label: `${key}'s earlier reply`, side: earlier },
    );
  }
  return live;
}

/** Returns the record for `rollout` at `key`; one over the size limit refuses, naming the key. */
export function rolloutRecord(key: string, rollout: Rollout): Uint8Array<ArrayBuffer> {
  try {
    return encodeRollout(rollout);
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new PublishError(`${key}: ${e.message}`);
  }
}

/**
 * Refuses a move from `at` to another `goal` percentage unless it rises or the rollout ends.
 * So a key never returns to bytes it held, and an ETag match, content hash or not, always means unchanged since read.
 */
function forward(key: string, at: number, goal: number): void {
  if (at === 100) {
    throw new PublishError(
      `${key}'s rollout is complete: start another with tide publish --rollout, or use tide rollback`,
    );
  }
  if (at === 0) {
    throw new PublishError(
      `${key}'s rollout was reverted: publish a fix with tide publish, or use tide rollback`,
    );
  }
  if (goal !== 0 && goal < at) {
    throw new PublishError(
      `${key} is at ${at}%: a rollout percentage only rises; lowering it never moves a device back, so use tide rollout revert or tide rollback`,
    );
  }
}

/**
 * Returns the earlier reply a new rollout over `previous` keeps, after verifying it: the pointer's reply, a complete
 * rollout's new reply, or none for no pointer. Any other rollout is refused.
 */
export async function earlierOf(
  identity: Identity,
  key: string,
  previous: PointerState,
): Promise<Rollout["earlier"]> {
  const { reply, sides = [] } = previous;
  if (reply === undefined) return undefined;
  // readPointer has refused it already; this narrows the type.
  if (reply.kind === "noUpdateAvailable") throw new PublishError(`${key} holds no update`);
  if (reply.kind !== "rollout") {
    await checkCopied(key, sides, identity);
    return reply;
  }
  if (reply.percent !== 100) {
    throw new PublishError(
      `${key} holds a rollout: finish it with tide rollout complete, or replace it with tide publish, republish or rollback`,
    );
  }
  await checkCopied(key, sides.slice(0, 1), identity);
  return reply.new;
}

/**
 * Returns the line of a target an earlier run of this same publish already staged: its pointer holds an unfinished
 * rollout whose new update's release record is `draft`'s. At `percent` it is skipped once both sides verify; at another
 * it refuses. A complete rollout is no partial run: its new reply becomes the earlier one.
 */
export async function stagedRollout(
  writer: Writer,
  target: { readonly key: string; readonly previous: PointerState },
  draft: DraftRecord,
  percent: number,
): Promise<PointerWrite | undefined> {
  const { key, previous } = target;
  const { reply, sides = [] } = previous;
  if (reply?.kind !== "rollout" || reply.percent === 100) return undefined;
  const record = await readReleaseRecord(writer.bucket, recordKey(reply.new.updateId));
  if (record === undefined) return undefined;
  const { updateId, createdAt } = record;
  if (!sameBytes(encodeRecord({ ...draft, updateId, createdAt }), encodeRecord(record))) {
    return undefined;
  }
  if (reply.percent !== percent) {
    throw new PublishError(
      `${key} already stages this export at ${reply.percent}%: change it with tide rollout`,
    );
  }
  await checkCopied(key, sides, writer.identity);
  return { key, previous, reply: undefined, line: `${key} ${updateId} ${createdAt}` };
}

function parse(args: readonly string[]) {
  const { values, positionals } = parsed(ROLLOUT_USAGE, () =>
    parseArgs({
      args: [...args],
      options: {
        channel: { type: "string" },
        "runtime-version": { type: "string" },
        platform: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: true,
    }),
  );
  const { channel, platform } = values;
  const runtime = values["runtime-version"];
  const [value] = positionals;
  if (positionals.length !== 1 || value === undefined) {
    throw new PublishError(`give one percentage, complete or revert; ${ROLLOUT_USAGE}`);
  }
  if (channel === undefined || runtime === undefined) {
    throw new PublishError(`--channel and --runtime-version are required; ${ROLLOUT_USAGE}`);
  }
  const goal =
    value === "complete" ? 100 : value === "revert" ? 0 : percentOf(value, "the rollout");
  const keys = platformsOf(platform).map((p) => replyKey(channel, runtime, p));
  return { goal, keys };
}
