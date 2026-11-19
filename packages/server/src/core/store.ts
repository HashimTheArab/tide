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
