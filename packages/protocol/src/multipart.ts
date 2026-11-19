import { ProtocolError } from "./hash.ts";

/** The parts Expo Updates v1 defines, each with the one Content-Type it is sent with. */
const CONTENT_TYPES = {
  manifest: "application/json",
  directive: "application/json",
  extensions: "application/json",
  certificate_chain: "application/x-pem-file",
} as const;

export type PartName = keyof typeof CONTENT_TYPES;
export type Header = readonly [name: string, value: string];

/** A part; encode writes Content-Disposition and Content-Type before `headers`, parse returns them in `headers`. */
export interface Part {
  readonly name: PartName;
  readonly headers: readonly Header[];
  readonly body: Uint8Array<ArrayBuffer>;
}

/** RFC 9110 token. */
export const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const HEADER_NAME = new RegExp(`^${TOKEN}$`);
const HEADER_VALUE = /^[\x21-\x7E](?:[\t\x20-\x7E]*[\x21-\x7E])?$/;
const BOUNDARY = /^[0-9A-Za-z_-]{1,70}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CRLF = encoder.encode("\r\n");
const DASHES = encoder.encode("--");

/**
 * Returns a multipart/mixed body of `parts` in order. Without `boundary` a random one is drawn; a given boundary
 * that occurs anywhere in a part is rejected, so every CRLF--boundary in the body is a delimiter.
 */
export function encodeMultipart(
  parts: readonly Part[],
  boundary?: string,
): { boundary: string; body: Uint8Array<ArrayBuffer> } {
  if (boundary !== undefined) checkBoundary(boundary);
  if (parts.length === 0) throw new ProtocolError("parts", "must not be empty");
  const names = new Set<PartName>();
  const framed = parts.map((part, i) => {
    const field = `parts[${i}]`;
    const name: unknown = part.name;
    if (!isPartName(name)) throw new ProtocolError(`${field}.name`, "is not a known part name");
    if (names.has(name)) throw new ProtocolError(`${field}.name`, "duplicates another part");
    names.add(name);
    const headers: Header[] = [
      ["Content-Disposition", `form-data; name="${name}"`],
      ["Content-Type", CONTENT_TYPES[name]],
      ...part.headers,
    ];
    checkHeaders(headers, field);
    const head = encoder.encode(headers.map(([n, v]) => `${n}: ${v}\r\n`).join(""));
    return { field, head, body: part.body };
  });

  let chosen: string;
  if (boundary === undefined) {
    do chosen = randomBoundary();
    while (framed.some((p) => containsBoundary(p.head, p.body, encoder.encode(chosen))));
  } else {
    chosen = boundary;
    for (const p of framed) {
      if (containsBoundary(p.head, p.body, encoder.encode(chosen))) {
        throw new ProtocolError(p.field, "contains the boundary");
      }
    }
  }

  const chunks: Uint8Array[] = [];
  for (const p of framed)
    chunks.push(encoder.encode(`--${chosen}\r\n`), p.head, CRLF, p.body, CRLF);
  chunks.push(encoder.encode(`--${chosen}--\r\n`));
  return { boundary: chosen, body: concat(chunks) };
}

/**
 * Returns the parts of a multipart/mixed body with their exact body bytes. Strict: no preamble or epilogue, known
 * part names only, each once, with their fixed Content-Type, and no occurrence of the boundary inside a part.
 */
export function parseMultipart(input: Uint8Array<ArrayBuffer>, boundary: string): Part[] {
  checkBoundary(boundary);
  const bytes = new Uint8Array(input);
  const token = encoder.encode(boundary);
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  // The first delimiter has no leading CRLF because there is no preamble.
  const open = encoder.encode(`--${boundary}\r\n`);
  if (!startsWith(bytes, open, 0)) {
    throw new ProtocolError("body", "must start with the boundary delimiter");
  }
  const parts: Part[] = [];
  const names = new Set<PartName>();
  let pos = open.length;
  for (;;) {
    const field = `parts[${parts.length}]`;
    const headStart = pos;
    const headers: Header[] = [];
    for (;;) {
      const eol = indexOf(bytes, CRLF, pos);
      if (eol === -1) throw new ProtocolError(field, "headers must end with an empty line");
      const line = bytes.subarray(pos, eol);
      pos = eol + CRLF.length;
      if (line.length === 0) break;
      headers.push(parseHeaderLine(line, `${field}.headers[${headers.length}]`));
    }
    checkHeaders(headers, field);
    const name = partName(headers, field);
    if (names.has(name)) throw new ProtocolError(field, "duplicates another part name");
    names.add(name);

    const end = indexOf(bytes, delimiter, pos);
    if (end === -1) throw new ProtocolError("body", "is missing the closing boundary");
    const body = bytes.slice(pos, end);
    if (containsBoundary(bytes.subarray(headStart, pos), body, token)) {
      throw new ProtocolError(field, "contains the boundary");
    }
    parts.push({ name, headers, body });

    pos = end + delimiter.length;
    if (startsWith(bytes, CRLF, pos)) {
      pos += CRLF.length;
      continue;
    }
    if (!startsWith(bytes, DASHES, pos)) {
      throw new ProtocolError("body", "must follow a boundary with CRLF or --");
    }
    pos += DASHES.length;
    const rest = bytes.length - pos;
    if (rest === 0 || (rest === CRLF.length && startsWith(bytes, CRLF, pos))) return parts;
    throw new ProtocolError("body", "must end after the closing boundary");
  }
}

function isPartName(name: unknown): name is PartName {
  return typeof name === "string" && Object.hasOwn(CONTENT_TYPES, name);
}

function checkBoundary(boundary: unknown): void {
  if (typeof boundary !== "string" || !BOUNDARY.test(boundary)) {
    throw new ProtocolError("boundary", "must be 1 to 70 characters of A-Z, a-z, 0-9, _ or -");
  }
}

/** Header rules shared by encoder and parser, so each accepts exactly what the other writes. */
function checkHeaders(headers: readonly Header[], field: string): void {
  const seen = new Set<string>();
  headers.forEach(([name, value]: readonly unknown[], i) => {
    const at = `${field}.headers[${i}]`;
    if (typeof name !== "string" || !HEADER_NAME.test(name)) {
      throw new ProtocolError(at, "name must be an RFC 9110 token");
    }
    if (typeof value !== "string" || !HEADER_VALUE.test(value)) {
      throw new ProtocolError(at, "value must be printable ASCII without edge whitespace");
    }
    if (seen.has(name.toLowerCase())) throw new ProtocolError(at, "duplicates another header");
    seen.add(name.toLowerCase());
  });
}

function parseHeaderLine(line: Uint8Array, field: string): Header {
  const text = decoder.decode(line);
  const colon = text.indexOf(":");
  if (colon === -1) throw new ProtocolError(field, "must be name: value");
  return [text.slice(0, colon), text.slice(colon + 1).replace(/^[\t ]+|[\t ]+$/g, "")];
}

function partName(headers: readonly Header[], field: string): PartName {
  const value = (name: string) => headers.find(([n]) => n.toLowerCase() === name)?.[1];
  const disposition = value("content-disposition");
  if (disposition === undefined) throw new ProtocolError(field, "is missing Content-Disposition");
  const name = /^form-data; name="([a-z_]+)"$/.exec(disposition)?.[1];
  if (!isPartName(name)) {
    throw new ProtocolError(field, "must be form-data with a known part name");
  }
  if (value("content-type") !== CONTENT_TYPES[name]) {
    throw new ProtocolError(field, `must have Content-Type ${CONTENT_TYPES[name]}`);
  }
  return name;
}

function containsBoundary(head: Uint8Array, body: Uint8Array, token: Uint8Array): boolean {
  return indexOf(head, token, 0) !== -1 || indexOf(body, token, 0) !== -1;
}

function randomBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array, at: number): boolean {
  return indexOf(bytes.subarray(at, at + prefix.length), prefix, 0) === 0;
}

function indexOf(bytes: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
