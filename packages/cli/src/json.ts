/**
 * Returns `value` as one line of JSON in printable ASCII, so no stored byte reaches a terminal raw. Field order is the
 * literal's, so a list keyed by stored data must be an array.
 */
export function jsonDocument(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
