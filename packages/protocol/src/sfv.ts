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

const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_.*-]/;
const TOKEN_CHAR = /[!#$%&'*+.^_`|~0-9A-Za-z:/-]/;

/**
 * Returns the members of an RFC 8941 dictionary: a string item's value, or null for any other item or inner list.
 * Parameters are dropped and a repeated key keeps its last value.
 */
export function parseSfvDictionary(value: string, field: string): Map<string, string | null> {
  const fail = (reason: string): never => {
    throw new ProtocolError(field, `is not an RFC 8941 dictionary: ${reason}`);
  };
  const members = new Map<string, string | null>();
  let at = 0;
  const peek = () => value[at] ?? "";
  const skip = (chars: string) => {
    while (at < value.length && chars.includes(peek())) at++;
  };

  const key = (): string => {
    const start = at;
    if (!KEY_START.test(peek())) fail(`expected a key at ${at}`);
    at++;
    while (KEY_CHAR.test(peek())) at++;
    return value.slice(start, at);
  };

  /** Returns a string item's value, or null for any other bare item. */
  const bareItem = (): string | null => {
    const c = peek();
    if (c === '"') {
      let s = "";
      for (at++; ; at++) {
        const ch = peek();
        if (ch === "") return fail("unterminated string");
        if (ch === '"') break;
        if (ch === "\\") {
          at++;
          if (peek() !== '"' && peek() !== "\\") fail(`bad escape at ${at}`);
          s += peek();
        } else if (ch < " " || ch > "~") {
          fail(`bad string character at ${at}`);
        } else s += ch;
      }
      at++;
      return s;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?(?:\d{1,15}(?![\d.])|\d{1,12}\.\d{1,3}(?!\d))/.exec(value.slice(at));
      if (m === null) return fail(`bad number at ${at}`);
      at += m[0].length;
    } else if (/[A-Za-z*]/.test(c)) {
      for (at++; TOKEN_CHAR.test(peek()); at++);
    } else if (c === ":") {
      const m = /^:[A-Za-z0-9+/=]*:/.exec(value.slice(at));
      if (m === null) return fail(`bad byte sequence at ${at}`);
      at += m[0].length;
    } else if (c === "?") {
      if (value[at + 1] !== "0" && value[at + 1] !== "1") fail(`bad boolean at ${at}`);
      at += 2;
    } else fail(`expected an item at ${at}`);
    return null;
  };

  const parameters = () => {
    while (peek() === ";") {
      at++;
      skip(" ");
      key();
      if (peek() === "=") {
        at++;
        bareItem();
      }
    }
  };

  const itemOrInnerList = (): string | null => {
    if (peek() !== "(") {
      const item = bareItem();
      parameters();
      return item;
    }
    for (at++; ;) {
      skip(" ");
      if (peek() === ")") break;
      bareItem();
      parameters();
      if (peek() !== " " && peek() !== ")") fail(`expected space or ) at ${at}`);
    }
    at++;
    parameters();
    return null;
  };

  skip(" ");
  while (at < value.length) {
    const k = key();
    let member: string | null = null; // A bare key is the boolean true.
    if (peek() === "=") {
      at++;
      member = itemOrInnerList();
    } else parameters();
    members.set(k, member);
    skip(" \t");
    if (at === value.length) break;
    if (peek() !== ",") fail(`expected , at ${at}`);
    at++;
    skip(" \t");
    if (at === value.length) fail("trailing comma");
  }
  return members;
}
