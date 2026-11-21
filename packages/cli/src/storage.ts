import { storageFromEnv } from "@tide-ota/protocol";

import type { Bucket } from "./bucket.ts";
import { BucketError } from "./bucket.ts";
import { diskBucket } from "./disk.ts";
import { s3Bucket } from "./s3.ts";

/**
 * Returns the bucket the environment configures, with the server's variables: TIDE_DISK_DIR or TIDE_S3_*. A
 * configuration error is a `BucketError` naming variables and rules, never values, and nothing has been sent.
 */
export function bucketFromEnv(env: Readonly<Record<string, string | undefined>>): Bucket {
  let storage;
  try {
    storage = storageFromEnv(env);
  } catch (e) {
    throw new BucketError((e as Error).message, "failed");
  }
  return "disk" in storage ? diskBucket(storage.disk) : s3Bucket(storage.s3);
}
