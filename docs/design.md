---
status: draft
updated: 2026-11-22
---

# Design

Tide serves Expo Updates protocol v1 to stock `expo-updates` clients. The CLI builds, signs and uploads every
reply ahead of time; the server picks a stored reply from request headers and streams it. Decisions behind this are
in [0001](decisions/0001-architecture.md).

## Client rules the design follows

Tide requires code signing. Apps must ship a code-signing certificate (`updates.codeSigningCertificate`), and the
CLI refuses to publish without a key. Without it, anyone who can write the bucket could make apps run their code.

- A client checks on launch (and, depending on the app, on foreground) and never needs the server to start.
- It applies a manifest only if its `createdAt` is newer than the update it runs, after filtering by
  `expo-manifest-filters`. So a rollback is a new, newer publish: a pointer can never move back in time.
- It verifies `expo-signature` over the exact bytes of the multipart part, and each asset's SHA-256.
- With bsdiff enabled (default from SDK 56, expo-updates 56.0.13; opt-in on 55 with `enableBsdiffPatchSupport`), a
  launch-asset request carries `A-IM: bsdiff`,
  `Expo-Current-Update-ID` (the running update, which can be the embedded one) and `Expo-Requested-Update-ID`.
  It accepts a patch only with `im: bsdiff` or status 226 and `expo-base-update-id` equal to its current ID, applies
  `BSDIFF40`, checks the hash, and refetches the full file on any failure.
- Asset URLs are inside signed manifests, so a published URL must work for as long as any device can request it.
- A client reuses a cached asset whose manifest `key` it already has, without downloading or hashing it again. So a
  key must never name different bytes in two updates, embedded builds included.

## Storage

One bucket (R2 or S3-compatible), written only by the CLI:

```
assets/<sha256>                          immutable non-launch assets
bundles/<sha256>                         launch bundles
updates/<updateId>.json                  release record (CLI, Release records)
reply/<channel>/<runtime>/<platform>     stored reply: a signed manifest or rollBackToEmbedded (the pointer)
reply/no-update                          stored reply: the signed noUpdateAvailable
legacy/map.json                          content keys that URLs from earlier servers name (legacy import)
bases/<updateId>                         base record: a launch bundle patches start from (Base records)
patches/<fromHash>/<toHash>              BSDIFF40 patch between two launch bundles (Patches)
```

The server's credentials are read-only, with one exception: a Workers R2 binding cannot be made read-only, so the
Worker holds write access it never uses. Its store type admits only `get`, and only `src/workers.ts` touches the
binding. Code running inside the Worker could delete objects; it could not make a write pass the client's signature
and hash checks. An operator who needs a strictly read-only Worker can point the S3 adapter at R2's S3 API with a
read-only token.

- **Keys** are a known prefix plus a hash (`assets/` or `bundles/` and 64 lowercase hex), a release record
  (`updates/<lowercase UUID>.json`), a base record (`bases/<lowercase UUID>`), a patch (`patches/` and two 64
  lowercase hex content keys, from then to) or a reply key. All but reply keys are lowercase, so they are distinct on
  a case-insensitive disk and need no escaping. Objects are stored
  unencoded; an object with a `content-encoding` other than `identity` is an error, not an asset.
- **Reply keys** come from protocol `replyKey`, shared by server and CLI. Channel and runtime version are each 1 to 64
  of `A-Z a-z 0-9 . _ + - ( ) :`, and neither is `.` or `..`, so no header value can name another key; platform is `ios` or
  `android`. S3 receives each key segment percent-encoded (`+` as `%2B`). The grammar covers every Expo runtime
  policy: `appVersion` (`2.6.2`), `nativeVersion` (`1.0.0(1)`) and `sdkVersion` (`exposdk:57.0.0`).
- **S3** (Node): path-style GetObject signed with SigV4. The credentials need `s3:GetObject` and `s3:ListBucket`;
  without ListBucket, S3 answers a missing key with 403, which the server must treat as an outage. Configured by
  `TIDE_S3_ENDPOINT`, `TIDE_S3_REGION`, `TIDE_S3_BUCKET`, `TIDE_S3_ACCESS_KEY_ID` and `TIDE_S3_SECRET_ACCESS_KEY`.
  The bucket name is 3 to 63 of `a-z 0-9 . -`, starting and ending alphanumeric; the region is 1 to 32 of
  `a-z 0-9 -` (`auto` on R2). The access key ID is 16 to 128 alphanumerics and the secret 16 to 256 printable ASCII
  characters.
- **S3 errors** name the operation, the HTTP status and the S3 error code only when it is on a fixed list of
  documented codes (`AccessDenied`, `NoSuchKey`, `PreconditionFailed`, `SlowDown`, `InternalError` and a few more);
  any other code is "unrecognised". A network failure, a timeout and an unusable 200 each have fixed text. No
  message holds a key, a header value, the provider's `<Message>` or fetch's cause, so no credential reaches a log.
  A 404 is absence only when the body is an S3 error document with one direct `Code` of `NoSuchKey`.
  SigV4 and these rules live in protocol `s3.ts`, shared by the server and the CLI.
- **Disk** (Node, tests and single-host development): `TIDE_DISK_DIR`. The root is trusted: only the publisher
  writes it; the server only reads it. Containment is the key grammar alone, checked before any filesystem call;
  there are no symlink, realpath or volume checks and no metadata files except `.tide/`, which holds the CLI's writer
  mutex and staged files and which no key can name. A root missing after startup is an outage (503), not a miss.
  Protocol `diskPath` maps a key to its file: in a reply key, every character of channel and runtime outside
  `a-z 0-9` becomes `_` and two hex digits (`Main` is `_4dain`), so names differing only in case stay distinct on a
  case-insensitive filesystem and no channel collides with the `reply/no-update` file.
- The Node entry needs exactly one of the two and exits before listening otherwise.

### Stored replies

One JSON object per reply key, encoded and decoded by protocol `encodeStoredReply` and `decodeStoredReply`; the
golden files are `packages/protocol/test/fixtures/*.reply.json`. Keys in this order, no trailing newline:

```json
{"version":1,"kind":"manifest","updateId":"<uuid>","contentType":"multipart/mixed; boundary=<b>","manifestFilters":"branch=\"main\"","body":"--<b>\r\n…"}
```

- `kind` is `manifest`, `rollBackToEmbedded` or `noUpdateAvailable`. Only `manifest` has `updateId` (a lowercase UUID)
  and `manifestFilters` (empty, or exactly what `encodeSfvDictionary` writes, at most 4 KiB).
- `body` is the exact signed multipart as a string. It is UTF-8 by construction, so the string round-trips its bytes;
  nothing parses or re-serialises it. A record is at most 2 MiB; encode refuses a larger one.
- Any other `version` is unreadable. A new layout bumps it, and the CLI must not write it before servers read it.
- The bucket is trusted, so neither codec nor server checks signatures, framing or that fields agree with the body.
  The publisher builds the record from what it has just built and signed: the boundary `encodeMultipart` returned,
  the kind of the part it built, `updateId` from the signed manifest's `id`, and the key's runtime from its
  `runtimeVersion`. Each filter member is a signed metadata member (key lowercased, same value), so the client's
  filter check passes. Metadata keys must stay distinct after lowercasing and Unicode canonical equivalence (NFC):
  iOS compares Swift strings that way and traps on duplicate dictionary keys.
- A publish replaces a record whole (R2 and S3 atomically; on disk a temporary file and a rename), so a request reads
  the old reply or the new one, never a mix.

### Base records

One JSON object per base, encoded and decoded by protocol `encodeBaseRecord` and `decodeBaseRecord`; the golden files
are `packages/protocol/test/fixtures/base-*.json`. Keys in this order, no trailing newline, at most 256 KiB:

```json
{"version":1,"kind":"update","updateId":"<uuid>","runtimeVersion":"1.0.0","platform":"ios","launchAsset":{"hash":"<b64url>"}}
{"version":1,"kind":"embedded","updateId":"<uuid>","runtimeVersion":"1.0.0","platform":"android","launchAsset":{"hash":"<b64url>"},"assets":[{"key":"<k>","hash":"<b64url>"}]}
```

- `kind` is `update` (an OTA update; its assets are in its release record) or `embedded` (a store build), which alone
  has `assets`: the embedded keys and SHA-256s the asset key identity check compares.
- Field rules are the release record's: a lowercase UUID, the reply-key name grammar for the runtime, `ios` or
  `android`, canonical base64url SHA-256 hashes, asset keys of 1 to 64 `A-Z a-z 0-9 _ -`.
- Encode sorts `assets` by key in code-unit order and collapses entries repeating a key and hash (Expo lists one per
  scale). Keys equal after lowercasing must share one hash, as publish requires (iOS keeps asset files on a
  case-insensitive disk).
- Decode checks the size, then `version` (any other is unreadable), then requires the exact bytes encode writes for
  what it parsed, so key order, whitespace, escapes, repeats and unsorted assets are all refused.

### Patches

`patches/<fromHash>/<toHash>` holds a BSDIFF40 patch exactly as bsdiff 4.3 writes it, what the expo-updates bspatch
reads: a 32-byte header (`BSDIFF40`, then the ctrl block length, diff block length and output size, each 8 bytes
little-endian sign-magnitude), then three bzip2 streams: ctrl triples (add, copy, seek), diff bytes added to the base,
and extra bytes copied.

The CLI's `makeBsdiff(base, target)` writes them: bsdiff 4.3's matching under a work budget (past it, the rest of the
target goes to extra), then level-9 bzip2 streams. It takes inputs of at most 64 MiB and depends only on the input
bytes.

Protocol `applyBsdiff(base, patch, maxOutput)` runs in the CLI, which applies and hash-checks every patch before
upload (publish step 5); the server only serves stored bytes. It is stricter than reference bspatch, and accepts
every patch bsdiff writes:

- `maxOutput` must be a non-negative safe integer, and a declared output over it is refused before anything is allocated. Header lengths
  are non-negative and below 2^53, and the ctrl and diff blocks fit in the patch.
- Each triple is checked before it is used: add and copy are non-negative, no value is negative zero or 2^53 or more,
  writes stay inside the output, reads stay inside the base (bspatch skips adds outside it; bsdiff never writes one),
  and every seek lands in `[0, base length]`.
- Each block is exactly one bzip2 stream: block and stream CRCs match, no randomised block, no block ending inside a
  run, every Huffman table (used or not) satisfies the Kraft inequality, zero padding, nothing after it. When the
  output is complete, ctrl, diff and extra must all be at their end.
- Work is bounded: the bzip2 reader holds one block, ctrl may decode at most one triple per output byte plus one, and
  diff and extra at most the output size. Any refusal is a `ProtocolError`; the client falls back to the full bundle.

## Server

A Hono app in `packages/server/src/core` that uses only web-standard APIs and one `Store.get(key)` interface.
Entry points: `workers.ts` (R2 binding) and `node.ts` (S3 API, or a local disk for tests and single-host
development). No application cache. `Store.get` resolves undefined only for an object that does not exist. A
failed read of what a route serves is a non-cacheable 5xx, never a 404; an optional lookup (a `/bundles` patch)
that fails falls back to the full reply instead.

### `GET /manifest`

An empty request header counts as absent. In order:

1. `expo-platform` other than `ios` or `android`: 400.
2. A configured app ID (`TIDE_APP_ID`, Workers var or Node env; empty is unset) that differs from a present
   `expo-app-id`: 400. An absent header is accepted.
3. `expo-protocol-version` present and not `1`, or an `accept` that contains none of `multipart/mixed`, `multipart/*`
   and `*/*`: 406. A substring check that ignores parameters and q-values: stock clients send `multipart/mixed`, the
   only type Tide serves.
4. `expo-channel-name` or `expo-runtime-version` missing or outside the reply key grammar: 400. There is no default
   channel: a misconfigured app sees a 400 in its logs rather than a silent no-update, and keeps its current update.
5. No pointer for `<channel>/<runtime>/<platform>`: the stored `reply/no-update`.
6. `Expo-Current-Update-ID` equal to the manifest pointer's update ID (compared ignoring case): the stored
   `reply/no-update`.
7. Otherwise the pointer. A rollback is served even to a client running its embedded update: the client applies it
   only when its `commitTime` is newer than the running update's, and applying it stops an OTA update it already
   downloaded from launching next.

A served reply is 200 with the stored body, `content-type: multipart/mixed; boundary=…`, `expo-protocol-version: 1`,
`expo-sfv-version: 0`, `cache-control: private, max-age=0`, and, for a manifest only, the stored
`expo-manifest-filters` (even when empty: a client keeps earlier filters when the header is absent). Each part
carries `Content-Disposition: form-data; name="manifest"` (or `"directive"`), `Content-Type: application/json` and
`expo-signature: sig="<base64>", keyid="<id>"` over its exact bytes.

One deadline (10 s) covers every read of a request. A missing `reply/no-update` when it is needed, a record over
2 MiB (checked from its stored size before reading), one that fails to decode or has the wrong kind for its key, a
store error, and a read past the deadline are each 503 with `cache-control: no-store`; 400 and 406 are `no-store`
too.

### `GET /bundles/<sha256>`

Every manifest's `launchAsset.url` points here, so the server sees patch negotiation. HEAD answers the same headers
with no body and cancels every stream it holds.

- A path that is not 64 lowercase hex is 400. The read of `bundles/<hex>` starts at once and alone decides the rest:
  absent is 404, a store failure 503, each `no-store`, whatever the patch lookup finds. `A-IM` can turn a 200 into a
  226, never into an error.
- The lookup runs beside it only when `A-IM` lists `bsdiff` (case-insensitive, commas inside quoted parameters do not
  split items) with no `q` or a valid `q` above zero (RFC 3229 10.5.3), and `Expo-Current-Update-ID` and
  `Expo-Requested-Update-ID` are both UUIDs, compared lowercase. It reads `bases/<current>` and
  `bases/<requested>` (at most 256 KiB each, from the stored size) through `decodeBaseRecord`; each record's
  `updateId` must be the ID it was read by. The requested record's launch hash must be this path's, and then
  `patches/<current launch hex>/<this hex>` is read. Once either record rules a patch out (absent, a fault, or the
  requested hash naming another bundle), the other read is cancelled rather than awaited.
- A patch found: 226 with its bytes, `content-type: application/octet-stream`, `im: bsdiff`,
  `expo-base-update-id: <current ID, lowercase>`, `cache-control: private, no-store`, `vary: A-IM,
  Expo-Current-Update-ID, Expo-Requested-Update-ID`. The bundle read's body is cancelled.
- Anything else is 200, the full bundle as `application/javascript`, `public, max-age=31536000, immutable`, with
  the same `vary`: no or declined `A-IM`, a missing or malformed ID, an unknown base, a requested base naming
  another hash, no patch, and, logged, a base record that is oversized, fails to decode or names another ID, a store
  error on a base or patch, or the lookup passing its deadline. The full bundle is always correct and the client
  hashes it; a 503 would block every client on a broken base until the bucket is repaired.
- The lookup has its own 2 s deadline, so the fallback stays well inside the Android client's 10 s read timeout. The
  deadline covers the base reads and the patch's headers only, never a 226 body already on the wire.
- The server checks nothing it serves: not the patch bytes, the hashes, or that the bases share a runtime and
  platform (the CLI applied and hash-checked every patch before upload).
- Patches are never shared-cached: a cached patch under the plain URL would break the client's full-file retry. The
  200's `Vary` keeps a shared cache from answering a later `A-IM` request with a full bundle cached for a plain one;
  a cache that ignores `Vary` would do so, losing only the saving. Workers Cache (opt-in, unset in Tide's
  `wrangler.jsonc`) answers before the Worker runs; a deployment that enables it must let `/bundles/` requests
  carrying `A-IM` reach the Worker.

### Other routes

- Non-launch assets are served from the bucket's public domain (`TIDE_ASSET_URL`) at `assets/<hex>`, with the
  `Content-Type` and `Cache-Control` the CLI stored on upload. The Node server does not serve these paths, and the
  disk store keeps no metadata: a disk deployment needs a static origin over `TIDE_DISK_DIR/assets/` that sets each
  type, and the disk integration test covers manifest delivery only.
- `GET /assets?h=<hash>&ext=<ext>` streams `assets/<hex>`, for URLs published by earlier servers. `h` must be one
  canonical unpadded base64url SHA-256 (43 characters, zero trailing bits: protocol `assetHash`), else 400. The
  `content-type` comes from `ext`, a bare extension, through protocol `assetContentType`, the table the publisher
  also uses; no or an unknown `ext` gives `application/octet-stream`. A 200 is `public, max-age=31536000,
  immutable`; every other reply is `no-store` (404 when absent, 503 when the store fails). Earlier servers also
  served launch bundles this way, so the legacy import stores every object a legacy `?h=` URL names under
  `assets/`, launch bundles included, and records each key in `legacy/map.json`
  (`{"version":1,"keys":[...]}`: content keys in strictly ascending order, no trailing newline, at most 64 MiB).
  These URLs get no patches. A frozen map can cover other legacy URL shapes.
- `GET /hc`.

## CLI

**One writer at a time.** `publish`, `rollback`, `republish` and `register-build` run only as CI jobs in one
concurrency group (for example `concurrency: tide-publish`) that runs them one at a time (`deploy.md`, Publishing). There is no lock
object: a lease lock in a bucket cannot stop a delayed write from landing after another writer takes over. As a
backstop, the pointer write is conditional, so an accidental second writer fails cleanly instead of overwriting.

When `register-build` exits 1, the writer job retries it in place with its exact inputs (`deploy.md`, Publishing),
admitting no other writer, until it exits 0. A base PUT whose response was lost can still land; once a retry has
stored the same bytes, a late copy can only be refused or identical. Otherwise it could land after another writer had
committed another SHA-256 for one of its asset keys, on a build already installed. If the rule is broken anyway, the
next key check refuses, naming both sources.

### Bucket configuration

The CLI reads the same variables as the Node server: `TIDE_DISK_DIR`, or all five `TIDE_S3_*` (exactly one store;
empty counts as unset). A configuration error exits before any request.

- **Credentials.** `status` and `storage` need `s3:GetObject` and `s3:ListBucket`: the server's read-only key, or an
  R2 Object Read token. The writers add `s3:PutObject` (on R2, an Object Read & Write token scoped to the bucket);
  keep that key a protected CI secret. Nothing needs `s3:DeleteObject`. The secret is only used to derive
  signatures: it is never sent, put in a URL or printed.
- **Writes.** Every request is signed (SigV4, with the payload hash). Every PUT signs its own `Cache-Control`:
  `public, max-age=31536000, immutable` with a `Content-Type` for bundles and assets, `no-store` for everything
  else (fetch would otherwise add an unsigned `no-cache` to a conditional PUT, which S3 stores). A pointer write is `PutObject` with
  `If-Match: <etag>`, or `If-None-Match: *` for a first publish; a 412 is a lost race, and every other answer is an
  error. ETags are opaque strings, compared exactly. A write that got no answer, a 5xx, or a 200 without a valid ETag
  has an unknown outcome: the writer stops, exits non-zero, and the next run starts from what the bucket holds,
  since S3 and R2 may still commit it. Nothing is ever deleted, so a late write can never lose content it names.
- **Disk.** Writers on one host serialise on a SQLite lock in `.tide/mutex.sqlite` (an `fcntl` lock the OS frees
  when its holder dies). Each conditional write reads, compares and renames a staged file inside it. Readers take no
  lock. Network filesystems are not supported.
- **Clock.** The bucket's time is S3's `Date` header, or the local clock on disk.

`tide status` prints one line per pointer (`<channel> <runtime> <platform> <kind> <updateId|-> <createdAt|commitTime>`,
read from the stored signed part without re-serialising it) and whether `reply/no-update` is present, unreadable or
missing. It exits 1 if any record is unreadable, and 2 on a configuration or listing error. An unreadable record is
reported by its key, the same name a readable row prints, with a fixed reason; a name outside the key grammar and a
stored field are never printed.

**Project code.** Only `tide export` runs project code, and it reads no credential; the writers (`publish`,
`rollback`, `republish`, `register-build`) start no process. A child of a process holding a key could read it as the
same user, so no environment allowlist would protect a writer that ran Expo.

`tide export --out <dir> [--platform ios|android]... [--runtime-version <v>] [--project-root <dir>]
[--pass-env <name>]...` writes the export directory `publish --from` reads. `--out` and `--project-root` resolve
against the caller's directory; `--out` must not exist. Platforms default to both. Exit 0, or 2 on any refusal or
tool failure; stdout has one `<platform> <runtimeVersion>` line per platform.

1. `expo config --json` gives `updates.codeSigningMetadata` (`keyid` required printable ASCII, `alg` absent or
   `rsa-v1_5-sha256`; only those two members are kept) and `updates.codeSigningCertificate` (relative to the project
   root, a regular file of at most 64 KiB, UTF-8, passing the certificate profile, so it holds one certificate and
   nothing else).
2. `expo config --type public --json` (an object) and each platform's runtime: `expo-updates
   runtimeversion:resolve --platform <p>` (every Expo policy, resolved by Expo) unless `--runtime-version` is given.
   A runtime must be a string the reply key grammar accepts.
3. `expo export --output-dir <staging> --platform <p>...` into a temporary directory, read as `publish` reads an
   export (below). Only `metadata.json` and the files it names for the selected platforms are copied to
   `<dir>/dist/`: Expo also copies the project's `public/` folder into its output.
4. `tide-export.json`, at most 16 MiB, written under a temporary name and renamed last, so a failed export leaves no
   file a writer reads:

```json
{"version":1,"certificate":"-----BEGIN CERTIFICATE-----\n…","codeSigningMetadata":{"keyid":"main","alg":"rsa-v1_5-sha256"},"expoClient":{…},"platforms":{"ios":{"runtimeVersion":"1.0.0"}}}
```

Everything in the directory is served publicly (`expoClient` is every manifest's `extra.expoClient`; `dist` is what
is uploaded) or embedded in every shipped build (certificate, `keyid`, `alg`). Steps 1 and 2 refuse before `<dir>`
is created.

**Expo.** `expo` and `expo-updates` run from the nearest `node_modules/.bin` at or above the project root, with no
shell and an allowlisted environment: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `CI`,
`EXPO_PUBLIC_*` (Expo inlines them into the bundle), each `--pass-env` name (never a `TIDE_`, `AWS_` or `ACTIONS_`
one), `EXPO_NO_DOTENV=1`, `NODE_ENV=production` and `BABEL_ENV` as given or, when unset or empty, `production`: the
mode `expo export` forces, so config, runtime and bundle agree.

`tide publish --from <dir> --channel <name>` publishes one update per platform the export names. Exit 0 means every
pointer was written, 2 that the publish was refused before any write, 1 that it failed after writes began. stdout has
one line per pointer written: `<key> <updateId> <createdAt>`.

**Configuration.** `TIDE_SERVER_URL` (the Tide server) and `TIDE_ASSET_URL` (the bucket's public domain) are each an
absolute `https:` URL with no credentials, query or fragment, or `http:` to a loopback IP literal; a trailing `/`
is dropped. Plus the bucket (Bucket configuration) and a key (Keys).

**URL shapes**, permanent once published (no extension: the client names files by `key` and `fileExtension`):

- launch asset: `<TIDE_SERVER_URL>/bundles/<64 hex>`;
- asset: `<TIDE_ASSET_URL>/assets/<64 hex>`. Byte-identical files with two extensions share one object and its
  first upload's `Content-Type`; clients check the hash, not the type.

**Export.** The directory is untrusted input, checked once, by publish. `tide-export.json` (at most 16 MiB, UTF-8
JSON) holds exactly the fields above with `version` 1, a string certificate of at most 64 KiB, an object
`expoClient`, and one or more of `ios` and `android`, each only a `runtimeVersion` the key grammar accepts. Its
certificate must be the builds' (same DER) and its `keyid` theirs (Keys). Neither it nor `dist` may resolve outside
the directory, which must stay unchanged while publish runs. Every path in `metadata.json` must resolve inside
`dist` to a regular file. An asset path is `assets/<md5>` or `www.bundle/<md5>.<ext>` (DOM
components), the MD5 is its key, and the file's bytes must hash to it. Repeated identical entries collapse.

Steps, in order; every refusal comes before the first write, and all replies are signed in memory first:

1. Read the export and open the writer (Keys).
2. Refuse an asset key recorded for another SHA-256 in any retained release record or registered build, or in
   two of them, comparing keys case-insensitively. An unreadable release or base record refuses too.
3. Read each pointer and its ETag, then the bucket's time. Refuse a local clock more than a minute from it, or a
   certificate invalid by either clock.
4. Compose each platform's manifest under a fresh UUID with `createdAt = max(now, previous createdAt or commitTime
   + 1 ms)`, one clock sample for all; metadata `channel`, filter `channel="<channel>"`. Sign the exact part bytes
   (RSA PKCS#1 v1.5, SHA-256) through the key source.
5. Build patches to each platform's new bundle from every registered base of its runtime and platform: every
   `embedded` build plus the 5 newest `update` bases by their release record's `createdAt` (ties by update ID). An
   `update` base without a release record refuses. Bases whose launch hash is the new bundle's get none, bases
   sharing a launch hash share one patch, and a patch already stored is skipped. A base whose bundle is not in the
   `bundles/` listing refuses, whatever the sizes; then a base or new bundle over 64 MiB gets no patch and is never
   read. `makeBsdiff` builds each patch, and protocol `applyBsdiff` applies it to the base: a refusal, or a result
   whose SHA-256 is not the new bundle's, refuses the publish. A checked patch is kept only when at most half the
   new bundle's level-9 gzip size, the encoding every client accepts; otherwise the full bundle serves alone. Then
   build `reply/no-update` if it is missing, and re-check the certificate by both clocks.
6. Upload missing `bundles/` and `assets/` (put-if-absent; a lost race stored the same bytes), then kept patches
   at `patches/<from hex>/<to hex>` (put-if-absent, `no-store`; a lost race stored the same deterministic, checked
   bytes), then `reply/no-update` (a winner must verify under the identity), then each release record followed by
   its `update` base record (put-if-absent). A patch that lands late is harmless: no pointer names its target yet.
   Then,
   per platform, re-check the certificate by both clocks, each read afresh, and write the pointer with `If-Match` on
   its ETag, or `If-None-Match: *` when there was none. A lost race fails at once and keeps the other writer's pointer;
   an unknown outcome may be live, and the next run starts from what the bucket holds.

**Release records.** `updates/<updateId>.json` is one JSON object, keys in this order, no trailing newline, at most
2 MiB; decode refuses anything encode would not write byte for byte:

```json
{"version":1,"updateId":"<uuid>","channel":"main","runtimeVersion":"1.0.0","platform":"ios","createdAt":"<ISO ms Z>","serverUrl":"https://updates.example.com","assetUrl":"https://assets.example.com","launchAsset":{"hash":"<b64url>"},"assets":[{"key":"<md5>","hash":"<b64url>","fileExtension":".png"}],"extra":{…}}
```

The two bases and the URL shapes give back every original URL, so a republish keeps them after configuration
changes; a new URL shape needs a new `version`. `contentType` follows from `fileExtension`; the launch asset is
always `.bundle`.

**Rollback and republish.** Both take the identity from the build pins alone (Keys), read no app config, need no
`TIDE_SERVER_URL` or `TIDE_ASSET_URL`, and share publish's exit codes, clock and certificate checks,
`reply/no-update` repair and pointer writes. Every refusal, including each argument rule below, comes before the
first write; arguments are checked before the writer opens.

- `tide rollback --embedded --channel <name> --runtime-version <v> [--platform ios|android]...`
  writes, per platform, a signed `rollBackToEmbedded` with `commitTime = max(now, previous createdAt or commitTime +
  1 ms)`. The runtime is given, never resolved, and the pointer must exist: a typo must not pass for a rollback. It
  has no release record and no `expo-manifest-filters`. stdout: `<key> - <commitTime>`.
- `tide republish <updateId>... [--channel <name>] [--runtime-version <v>]` serves each
  update's stored code again under a fresh UUID, on `--channel` or the update's own channel. It is rebuilt from the
  release record by publish's own manifest builder, so hashes, keys, extensions, `extra` and URLs are the original's;
  only the ID, `createdAt = max(now, previous + 1 ms, source createdAt + 1 ms)`, `metadata.channel` and the filter
  change. It writes a new release record and base record, and uploads nothing. stdout as publish.
- `tide rollback --to <updateId> [--to <updateId>]...` is `republish` onto each update's own
  pointer, and takes no `--channel`, `--runtime-version` or `--platform`. `--to A B` is a usage error.

Refused: an ID that is not a lowercase UUID or is given twice; an ID with no release record; a release record that
is unreadable or names another ID; a record whose runtime differs from `--runtime-version`; two IDs with one target
pointer; a referenced bundle or asset that is not stored; and any asset key two retained records disagree on. A lost
race or unknown outcome behaves as publish; a record whose PUT has an unknown outcome is named, and no pointer refers
to it yet.

`tide storage` reports, read-only, every object under `assets/`, `bundles/` and `updates/` that nothing
references, one `<name> <bytes>` row each in byte order, then `<n> unreferenced objects, <total> bytes`. Referenced
means named by:

- any release record, all of which are retained (a record itself is never reported): `bundles/` for its launch hash
  and `assets/` for each asset. A pointer serves its release record, so it adds nothing;
- any base record: `bundles/` for its launch hash. Embedded assets live in the store build, not the bucket;
- `legacy/map.json`.

Nothing under `bases/` or `patches/` is ever reported.

A name outside the key grammar prints as a JSON string with every character outside printable ASCII written `\uXXXX`.
It writes nothing and takes no lock, so the report is exact for a quiescent bucket: a record committed after the
listing protects its content only from the next run. Exit 0 with the report; 1, with nothing on stdout, when a
listing or read fails or a record or the legacy map does not decode; 2 on a usage or configuration error.

`tide register-build --platform ios|android --runtime-version <v> --manifest <app.manifest> --bundle <file>
[--assets-dir <dir>]` records a store build as an `embedded` base record, so patches can start from its bundle and
its asset keys join the identity check. Nothing is signed or timestamped, so it needs no key, but it reads the build
pins (Keys) before the bucket is opened and refuses a bucket whose `reply/no-update` is absent or signed under another
identity: a build is registered only where its own certificate and `keyid` are already served, so a first publish
cannot pin another identity over its asset keys. Exit codes as publish; stdout
`bases/<id> bundles/<64 hex>`.

- **Inputs**, all from one build: its update ID is random per build, so mixing builds registers a base no installed
  client has. Android: `assets/app.manifest` and `assets/index.android.bundle` from the built APK (`base/assets/`
  in an AAB), and `--assets-dir app/build/generated/res/react/<variant>` from the same Gradle run. Build clean or
  with `--rerun-tasks`: `create<Variant>UpdatesResources` does not track JS sources, so an incremental build can
  pack a new bundle beside the previous build's manifest. The manifest names no bundle hash, so unless that ID is
  already registered, registration accepts the pair and every patch from it fails on installs of the earlier build.
  iOS: `main.jsbundle`, `assets/` and the manifest the client loads from the built `.app`: `app.manifest` in the
  `EXUpdates.bundle` beside the `EXUpdates` code (the `.app` root, since Expo links `EXUpdates` statically), else the
  `.app` root's own `app.manifest`. When images are compiled into an asset catalog (`RNAssets.xcassets`), pass the
  same build's Metro asset files from before catalog compilation instead.
- The update ID is the manifest's `id`, a lowercase UUID. Each manifest asset's key is its `packagerHash`
  (32 lowercase hex): the MD5 of the source file. Every regular file under `--assets-dir` (symlinks and other types
  skipped) is MD5-hashed, and the file matching each key gives its SHA-256. Files are found by content, never by
  location, since packaging may re-encode them; two files with one MD5 and different bytes refuse.
  `--assets-dir` is required only when the manifest lists assets.
- **Refused before any write** (exit 2): a missing or repeated option or a positional; a bad runtime or platform;
  a missing or invalid build pin; a bucket with no `reply/no-update` or signed under another identity;
  an ID that is not a lowercase UUID; an unreadable input; an asset key with no matching file; an asset key that a
  release record or another registered build records with another SHA-256; and a `bases/<id>` holding other bytes.
- **Writes**: `bundles/<hex>` put-if-absent (immutable, `application/javascript`), then `bases/<id>` put-if-absent.
  A lost base create succeeds only if the stored bytes are identical. Re-running with identical inputs writes nothing
  and exits 0. An unknown outcome exits 1, and the retry starts from the bucket (One writer at a time).

**Nothing is deleted.** The protocol requires a published asset URL to keep working, release records back the asset key
identity check, and storage is cheap (about 2 GB for 100 updates of a 10 MB bundle on two platforms). Deleting from an
object store safely while writes can land late would need machinery Tide does not want; if storage ever matters,
deletion gets its own design.

### `tide certificate`

`tide certificate --common-name <name> --validity-years <n>` prints the self-signed certificate the app embeds,
signed by the configured key source (Keys), so a key created inside KMS needs no copy anywhere else. It reads only
the key-source variables: no build pins, no bucket and no project code, and it opens no file for writing.

- **Arguments.** The common name is 1 to 64 printable ASCII characters with no space at either end; the validity is
  a whole number of years from 1 to 100.
- **Certificate.** X.509 v3 with a random positive 16-octet serial, `sha256WithRSAEncryption` with NULL parameters
  inside and outside the TBS, and one Name as issuer and subject holding only the common name. Validity runs from
  now, in whole seconds, to the same time `<n>` years later (29 February rolls to 1 March), as UTCTime through 2049
  and GeneralizedTime from 2050. Then the source's SubjectPublicKeyInfo and exactly two extensions: Key Usage
  (critical) `digitalSignature` and Extended Key Usage `codeSigning`.
- **Signing.** The source signs the TBS as `publish` signs a part: KMS signs its SHA-256 with `Sign` (`DIGEST`).
  The public key comes from the PEM key, or from KMS `GetPublicKey` on the same request path as `Sign`. A reply is
  refused unless the key is `SIGN_VERIFY`, `RSA_2048`, `RSA_3072` or `RSA_4096`, allows
  `RSASSA_PKCS1_V1_5_SHA_256`, and its public key is an RSA SubjectPublicKeyInfo of that size.
- **Checks, before any output.** The PEM passes the certificate profile (Keys), its public key is the source's, and
  `tide signing probe` signed by the source verifies under it, so a KMS key whose `Sign` and `GetPublicKey` disagree
  is refused.
- **Output.** stdout is exactly the PEM, one block of 64-column lines; redirect it to a file outside the app
  checkout, then copy it into the app (`deploy.md`, Signing identity).
  stderr is `tide: certificate DER SHA-256 <hex>`, the fingerprint the identity check compares. Exit 0, or 2 on any
  refusal with nothing on stdout. No message carries a key, credential or provider text.

## Keys

A leaked key can ship code to every installed app. Publish only from CI, and sign through KMS where possible. Tide
supports direct signing only: the app embeds one self-signed certificate, and its key signs every part.

**Key sources.** Exactly one is configured; an empty variable counts as unset.

| Variable | Source |
| --- | --- |
| `TIDE_SIGNING_KEY_FILE` | Path to an unencrypted PKCS#8 or PKCS#1 RSA private key PEM, at most 64 KiB |
| `TIDE_SIGNING_KEY` | The same PEM as the value |
| `TIDE_KMS_KEY_ID` | KMS key ID, ARN or alias, with `TIDE_KMS_REGION`, `TIDE_KMS_ACCESS_KEY_ID`, `TIDE_KMS_SECRET_ACCESS_KEY`; optional `TIDE_KMS_SESSION_TOKEN` and `TIDE_KMS_ENDPOINT` |

A PEM key must be RSA of 2048 to 4096 bits. KMS calls `Sign` with `RSASSA_PKCS1_V1_5_SHA_256` and `MessageType:
DIGEST` over the SHA-256 computed locally: `RAW` caps the message at 4096 bytes, which a manifest can exceed, and
both give the same signature. Requests are SigV4-signed without an AWS SDK, never follow a redirect, and go to
`https://kms.<region>.amazonaws.com` or `TIDE_KMS_ENDPOINT`, which must be an `https:` origin (plain `http:` only to
a loopback IP literal). Throttling, access denied, a disabled key, a timeout or a malformed reply is an error.
Writers call only `Sign`; `tide certificate` also calls `GetPublicKey` on the same request path.

**Build pins.** The checkout can drift from what installed builds embed, so every writer and `tide probe` take the
identity from the store builds, read from a shipped binary rather than the checkout:

- `TIDE_BUILD_KEYID`: the builds' `keyid`, printable ASCII. Expo's implicit `root` is never assumed.
- Exactly one of `TIDE_BUILD_CERTIFICATE_FILE` (a path, a regular file of at most 64 KiB) and
  `TIDE_BUILD_CERTIFICATE` (the PEM).

In an APK, `aapt2 dump xmltree --file AndroidManifest.xml app.apk` shows the meta-data
`expo.modules.updates.CODE_SIGNING_CERTIFICATE` and `CODE_SIGNING_METADATA`; in an IPA, `plutil -p
Payload/<App>.app/Expo.plist` shows `EXUpdatesCodeSigningCertificate` and `EXUpdatesCodeSigningMetadata`.

**Certificate profile.** One ASCII PEM block, each delimiter alone on its line, holding one self-signed X.509 v3
certificate, valid now, signed with `sha256WithRSAEncryption` (the same identifier inside and outside the TBS), with
well-formed Key Usage `digitalSignature`, Extended Key Usage `codeSigning`, no repeated extension, no Expo
project-information extension, and an RSA key of 2048 to 4096 bits. A renewed certificate does not pass while the
builds hold an expired one.

**Identity.** `publish` also refuses an export whose `codeSigningMetadata` (`keyid` printable ASCII, `alg` absent or
`rsa-v1_5-sha256`) names another `keyid`, or whose certificate is not the pinned one, compared by DER SHA-256.
`tide export` applies the same metadata rule and the profile before writing anything, so a malformed `keyid` or a
file holding a key never reaches an export.

**Probe.** Before the bucket is opened, the CLI signs `tide signing probe` and verifies it against the certificate
and `keyid`. Every later signature is verified the same way before it is returned, so a re-pointed KMS alias cannot
produce a part the app rejects. Every key, pin or export identity refusal exits before the bucket is opened; the bucket check only
reads replies. Each refusal has a fixed message that names variables and config fields, never a key,
credential or provider text.

**One signing identity per bucket.** Every build a bucket serves gets the same signed `reply/no-update`. When it
exists, the CLI requires its directive to be a signed `noUpdateAvailable` that verifies under the configured
certificate and `keyid`. When it is absent, every entry under `reply/` must be a pointer whose signed part verifies
the same way (an empty `reply/` is a new bucket), so no writer repairs another identity's bucket. A new key or key
ID therefore needs a new bucket and `updates.url`. `publish`, `rollback` and `republish` create a missing
`reply/no-update` with put-if-absent before any pointer and re-check a winner they did not write; and they re-check
the certificate's validity by both clocks after signing and, once a write has been attempted, before each pointer
write. No writer runs project code (CLI).

**KMS provisioning.** Prefer a key created inside KMS, whose private key never exists anywhere else:

1. `aws kms create-key --origin AWS_KMS --key-spec RSA_2048 --key-usage SIGN_VERIFY` (or `RSA_3072`, `RSA_4096`),
   with an alias.
2. The identity that runs `tide certificate` needs `kms:GetPublicKey` and `kms:Sign` on the key; writers need only
   `kms:Sign`.
3. `tide certificate` with the `TIDE_KMS_*` variables, run from a checked Tide install outside the app checkout,
   writes the app's certificate (`deploy.md`, Signing identity).

Such a key cannot be exported, so there is no recovery copy. Disabling it stops every publish until `enable-key`, and
a pending deletion can be cancelled with `cancel-key-deletion`, then `enable-key`. Once it is deleted, or left
disabled, every installed build is stranded: it keeps the updates it has, but nothing new is signed for it until a
new store build ships. That build needs a new key, a new bucket and a new `updates.url` (One signing identity per
bucket); certificate chains and per-`keyid` identities are roadmap P11. So schedule any deletion with the longest
waiting period, `schedule-key-deletion --pending-window-in-days 30`, and give the key a policy that allows
`kms:ScheduleKeyDeletion` and `kms:DisableKey` only to a break-glass role.

**Key import** keeps a recovery copy instead. The certificate is made offline and the key imported:

1. `npx expo-updates codesigning:generate` with all four flags (`deploy.md`, Signing identity), writing the key
   outside every checkout (for example `--key-output-directory ~/tide-signing/main`, never inside a repository), then
   `openssl pkcs8 -topk8 -nocrypt -outform DER` on the private key.
2. `aws kms create-key --origin EXTERNAL --key-spec RSA_2048 --key-usage SIGN_VERIFY` (the spec matching the key).
3. `get-parameters-for-import --wrapping-algorithm RSA_AES_KEY_WRAP_SHA_256`, wrap the DER, and
   `import-key-material --expiration-model KEY_MATERIAL_DOES_NOT_EXPIRE`.
4. Keep one encrypted recovery copy of the private key offline, outside AWS: if the imported material is deleted,
   only the same material restores signing for installed builds. Delete every other copy.

## Observability

Every `/manifest` request that reaches the reply decision (each 200 and 503) writes one Workers Analytics Engine
data point through the `ANALYTICS` binding (dataset `tide_manifest` in `wrangler.jsonc`). A 400 or 406 is answered
before that decision and writes none. The Node entry has no sink and records nothing.

| Field | Holds |
| --- | --- |
| `index1` | `expo-channel-name` |
| `blob1` | The reply served: `manifest`, `rollBackToEmbedded`, `noUpdateAvailable`, or `503` |
| `blob2` | `expo-platform`: `ios` or `android` |
| `blob3` | `expo-runtime-version` |
| `blob4` | `expo-current-update-id` |
| `blob5` | `expo-embedded-update-id` |
| `blob6` | `expo-recent-failed-update-ids`, comma-joined |
| `double1` | 1 when `expo-fatal-error` is present, else 0 |

Headers are client input, so each value is bounded before it is written. Channel and runtime already passed the
reply key grammar (at most 64 ASCII characters). An update ID is kept only when it is a UUID, lowercased, else empty;
a repeated header arrives joined and is dropped. The failed IDs are read as a list of quoted strings: members that
are quoted UUIDs are kept, lowercased and in order, up to 5 (a stock client sends at most 5); any other member is
dropped. `expo-fatal-error` holds the client's error message, which may contain user data, so only its presence is
recorded. A point is therefore at most 64 bytes of index and 345 bytes of blobs, well inside Analytics Engine's
limits (96-byte index, 16 KB of blobs).

The sink is never awaited: a sink that throws, rejects, or returns a promise that never settles leaves the reply
unchanged, and a throw or rejection is logged by error name only, never with the point's values.

### `tide probe`

A synthetic check that sees what an installed build would. It is read-only and needs no store credentials and no
signing key, so it can run from any monitor:

```
tide probe --server-url <url> --channel <name> --runtime-version <version> --platform ios|android [--app-id <id>]
```

`--server-url` is the base before `/manifest` (`https:`, or `http:` to a loopback IP literal). The pins are the
builds' own: `TIDE_BUILD_KEYID`, and the certificate the builds embed in exactly one of `TIDE_BUILD_CERTIFICATE_FILE`
(a path, at most 64 KiB) or `TIDE_BUILD_CERTIFICATE` (the PEM). The certificate must pass the same profile and
validity checks as at publish, so an expired one fails the probe.

The probe sends `GET /manifest` as a stock client: `expo-protocol-version: 1`, `expo-expect-signature` with the
pinned keyid, `accept: multipart/mixed`, and no current update ID, so a pointer is served whenever one exists. It
parses the multipart reply and verifies the `expo-signature` of the one manifest or directive part over its exact
bytes. A directive (`rollBackToEmbedded`, or `noUpdateAvailable` from `reply/no-update`) passes on that alone. A
manifest's signed `runtimeVersion` must be the one requested, and no `expo-manifest-filters` member may differ
from the signed `metadata` key it names, since a client launches neither. Its `launchAsset.url` is then fetched
wherever it points and its SHA-256 compared with `launchAsset.hash`; other assets are not fetched. `/manifest` has 10 s and the launch asset 60 s, each covering the body.

| Exit | Meaning |
| --- | --- |
| 0 | Passed; stdout names the directive, or the update ID and the launch asset hash checked |
| 2 | Usage or configuration; nothing was sent |
| 3 | Unreachable: a request failed or passed its deadline |
| 4 | `/manifest` or the launch asset answered a status other than 200 (404 for the asset is 7) |
| 5 | Unparseable reply: not `multipart/mixed`, no `expo-protocol-version: 1`, filters that are not a dictionary of strings, a bad body, no single signed part, or malformed JSON |
| 6 | Signature: missing, malformed, another keyid, or not verifying under the pinned certificate |
| 7 | The launch asset answered 404 |
| 8 | The launch asset's SHA-256 differs from the manifest's hash |
| 9 | The signed manifest is for another runtime version than `--runtime-version`, or its metadata fails the reply's filters |

Exit 1 is left to an uncaught error, so it always means a bug. Messages are fixed text naming the failure and at
most a status; no header value, key or response body is printed.
