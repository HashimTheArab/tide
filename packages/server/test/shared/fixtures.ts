import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    fixtures: Record<string, number[]>; // Every file in packages/protocol/test/fixtures, as bytes.
    fakeS3Endpoint: string; // This project's fake S3.
  }
}

/** Returns the bytes of a protocol golden fixture. */
export function fixture(name: string): Uint8Array<ArrayBuffer> {
  const bytes = inject("fixtures")[name];
  if (bytes === undefined)
    throw new Error(`packages/protocol/test/fixtures/${name} does not exist`);
  return new Uint8Array(bytes);
}

// The protocol's pinned client IDs: buckets 941 and 8977 of 10,000 in every rollout golden, so at 12.5% and 50% one
// is on each side. Tests never compute a side, so a routing bug cannot agree with itself.
export const CLIENT_LOW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const CLIENT_HIGH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
