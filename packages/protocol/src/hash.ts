/** The one error this package throws for malformed input; `field` names the offending input. */
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
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=$/, "");
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
