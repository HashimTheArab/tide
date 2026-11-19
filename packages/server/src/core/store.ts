/** An object's bytes and their length; the stream must be consumed or cancelled. */
export interface StoredObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

/** The server's read-only view of the bucket. */
export interface Store {
  /** Resolves undefined only when the object does not exist; every other failure rejects. */
  get(key: string): Promise<StoredObject | undefined>;
}

/** Returns whether `key` has one of the fixed shapes the publisher writes: a known prefix and a hex SHA-256. */
export function isStoreKey(key: string): boolean {
  return /^assets\/[0-9a-f]{64}$/.test(key);
}
