/** The one error this package throws for rejected input; `field` names the offending input. */
export class ProtocolError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field} ${message}`);
    this.name = "ProtocolError";
    this.field = field;
  }
}

/** Returns the SHA-256 of `bytes` as unpadded base64url, the Expo manifest `hash` field. */
export async function sha256Base64Url(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return base64(digest).replaceAll("+", "-").replaceAll("/", "_").replace(/=$/, "");
}

/** Returns the lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** Returns `bytes` as standard padded base64. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Returns the bytes of non-empty canonical padded base64, or undefined. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (
    text === "" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  ) {
    return undefined;
  }
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return base64(bytes) === text ? bytes : undefined;
}

/** Returns `value` if it is the canonical 43-character base64url encoding of a 32-byte digest. */
export function assetHash(value: unknown, field: string): string {
  // The last character carries 4 data bits and 2 zero bits.
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) {
    throw new ProtocolError(field, "must be 43 characters of base64url");
  }
  return value;
}

/**
 * Returns the storage key for the bytes behind `hash`: the digest as 64 lowercase hex characters.
 * Hex, not the hash itself, so keys stay distinct on case-insensitive disks.
 */
export function contentKey(hash: string): string {
  const binary = atob(`${assetHash(hash, "hash").replaceAll("-", "+").replaceAll("_", "/")}=`);
  let hex = "";
  for (let i = 0; i < binary.length; i++) hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}
