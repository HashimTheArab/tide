import type { StoredReply } from "@tide/protocol";
import { UUID } from "@tide/protocol";

/** Stock clients list at most this many recently failed updates. */
const MAX_FAILED_IDS = 5;
const QUOTED_UUID = /^"([0-9A-Fa-f-]{36})"$/;

/**
 * One `/manifest` request as a Workers Analytics Engine data point; the layout is in `docs/design.md`, Observability.
 * Every value is bounded, so a point stays far inside Analytics Engine's limits whatever the client sends.
 */
export interface ManifestPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/** Receives one point per `/manifest` request that reaches the reply decision. Its result is never awaited. */
export type AnalyticsSink = (point: ManifestPoint) => unknown;

/** Request values already checked by the route; the rest are raw headers, absent when empty. */
export interface ManifestRequest {
  readonly reply: StoredReply["kind"] | "503";
  readonly platform: "ios" | "android";
  readonly runtime: string; // Reply key grammar: at most 64 ASCII characters.
  readonly channel: string;
  readonly currentUpdateId: string | undefined;
  readonly embeddedUpdateId: string | undefined;
  readonly recentFailedUpdateIds: string | undefined;
  readonly fatalError: string | undefined;
}

/** Returns the data point for `r`. */
export function manifestPoint(r: ManifestRequest): ManifestPoint {
  return {
    indexes: [r.channel],
    blobs: [
      r.reply,
      r.platform,
      r.runtime,
      updateId(r.currentUpdateId),
      updateId(r.embeddedUpdateId),
      failedUpdateIds(r.recentFailedUpdateIds),
    ],
    // Only presence: the value is the client's error message, which may hold user data.
    doubles: [r.fatalError === undefined ? 0 : 1],
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
    const id = QUOTED_UUID.exec(member.trim())?.[1]?.toLowerCase() ?? "";
    if (UUID.test(id)) ids.push(id);
    if (ids.length === MAX_FAILED_IDS) break;
  }
  return ids.join(",");
}
