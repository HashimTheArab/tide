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
