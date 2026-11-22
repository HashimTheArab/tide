import type { StoredReply } from "@tide-ota/protocol";
import { UUID } from "@tide-ota/protocol";

/** Stock clients list at most this many recently failed updates. */
const MAX_FAILED_IDS = 5;
const QUOTED_UUID = new RegExp(`^"(${UUID.source.slice(1, -1)})"$`, "i");

/**
 * One `/manifest` request as a Workers Analytics Engine data point; the layout is in `docs/design.md`, Observability.
 * Every value is bounded, so a point stays far inside Analytics Engine's limits whatever the client sends.
 */
export interface ManifestPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/** The rollout side a request was assigned; `none` when the pointer holds no rollout or the reply is a 503. */
export type RolloutSide = "new" | "earlier" | "none";

/** Receives one point per `/manifest` request that reaches the reply decision; it is never awaited. */
export type AnalyticsSink = (point: ManifestPoint) => void;

/** `channel` and `runtime` must already match the reply key grammar; every other value is read raw from `header`. */
export function manifestPoint(
  reply: StoredReply["kind"] | "503",
  side: RolloutSide,
  platform: "ios" | "android",
  channel: string,
  runtime: string,
  header: (name: string) => string | undefined,
): ManifestPoint {
  return {
    indexes: [channel],
    blobs: [
      reply,
      platform,
      runtime,
      updateId(header("expo-current-update-id")),
      updateId(header("expo-embedded-update-id")),
      failedUpdateIds(header("expo-recent-failed-update-ids")),
      side,
    ],
    // Only presence: the value is the client's error message, which may hold user data.
    doubles: [header("expo-fatal-error") === undefined ? 0 : 1],
  };
}

/** Returns `value` lowercased when it is a UUID, else empty. */
function updateId(value: string | undefined): string {
  const id = value?.toLowerCase() ?? "";
  return UUID.test(id) ? id : "";
}

/**
 * Returns the UUIDs of an RFC 8941 list of strings, lowercased, comma-joined, in order and at most 5; every other
 * member is dropped.
 */
function failedUpdateIds(value: string | undefined): string {
  const ids: string[] = [];
  for (const member of value?.split(",") ?? []) {
    const id = QUOTED_UUID.exec(member.trim())?.[1];
    if (id !== undefined) ids.push(id.toLowerCase());
    if (ids.length === MAX_FAILED_IDS) break;
  }
  return ids.join(",");
}
