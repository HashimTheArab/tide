import { ProtocolError } from "./hash.ts";

/** Returns `members` as an RFC 8941 dictionary of strings, the `expo-manifest-filters` header value. */
export function encodeSfvDictionary(members: Readonly<Record<string, string>>): string {
  const entries: [string, unknown][] = Object.entries(members);
  return entries
    .map(([key, value]) => {
      if (!/^[a-z*][a-z0-9_.*-]*$/.test(key))
        throw new ProtocolError(key, "must be an RFC 8941 key");
      if (typeof value !== "string" || !/^[\x20-\x7E]*$/.test(value)) {
        throw new ProtocolError(key, "must be a string of printable ASCII");
      }
      return `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    })
    .join(", ");
}
