---
status: draft
updated: 2026-11-20
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
- With bsdiff enabled (default from SDK 57), a launch-asset request carries `A-IM: bsdiff`,
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

Protocol `applyBsdiff(base, patch, maxOutput)` runs in the CLI, which applies and hash-checks every patch before
upload; the server only serves stored bytes. It is stricter than reference bspatch, and accepts every patch bsdiff
writes:

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
development). No application cache. `Store.get` resolves undefined only for an object that does not exist; every
other failure is a non-cacheable 5xx, never a 404.

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

Every manifest's `launchAsset.url` points here, so the server sees patch negotiation.

- With `A-IM: bsdiff`: resolve `Expo-Current-Update-ID` through `bases/`, confirm `Expo-Requested-Update-ID` names an
  update whose launch hash is this one, and look up `patches/<base>/<this>`. Found: 226, `im: bsdiff`,
  `expo-base-update-id`, `cache-control: private, no-store`, `vary: A-IM, Expo-Current-Update-ID`.
- Otherwise: 200, the full bundle as `application/javascript`, `public, max-age=31536000, immutable`.
- A path that is not 64 lowercase hex is 400, an absent bundle 404 and a store failure 503, each `no-store`.
- Patches are never shared-cached: a cached patch under the plain URL would break the client's full-file retry.

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

**One writer at a time.** `publish`, `rollback`, `republish` and `register-build` (P5) run only from one CI
workflow whose concurrency group (for example `concurrency: tide-publish`) runs them one at a time. There is no lock
object: a lease lock in a bucket cannot stop a delayed write from landing after another writer takes over. As a
backstop, the pointer write is conditional, so an accidental second writer fails cleanly instead of overwriting.

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

`tide publish --channel <name> [--platform ios|android]... [--runtime-version <v>] [--export-dir <dir>]
[--project-root <dir>]`. Platforms default to both, and a repeated one is a usage error. Exit 0 means every pointer
was written, 2 that the publish was refused before any write, 1 that it failed after writes began. stdout has one
line per pointer written: `<key> <updateId> <createdAt>`.

**Configuration.** `TIDE_SERVER_URL` (the Tide server) and `TIDE_ASSET_URL` (the bucket's public domain) are each an
absolute `https:` URL with no credentials, query or fragment, or `http:` to a loopback IP literal; a trailing `/`
is dropped. Plus the bucket (Bucket configuration) and a key (Keys).

**URL shapes**, permanent once published (no extension: the client names files by `key` and `fileExtension`):

- launch asset: `<TIDE_SERVER_URL>/bundles/<64 hex>`;
- asset: `<TIDE_ASSET_URL>/assets/<64 hex>`. Byte-identical files with two extensions share one object and its
  first upload's `Content-Type`; clients check the hash, not the type.

**Expo.** `expo` and `expo-updates` run from the nearest `node_modules/.bin` at or above the project root, with no
shell, every `TIDE_` variable removed, `EXPO_NO_DOTENV=1`, `NODE_ENV=production` and `BABEL_ENV` as given or
`production`: the mode `expo export` forces, so config, runtime and bundle agree. The runtime is
`expo-updates runtimeversion:resolve --platform <p>` (every Expo policy, resolved by Expo) unless
`--runtime-version` is given. The full `expo config` gives the signing identity; `--type public` becomes
`extra.expoClient`.

**Export.** Without `--export-dir`, `expo export` runs into a temporary directory. A given `--export-dir` must hold
a production export of the same checkout and stay unchanged while publish runs. Every path in `metadata.json` must
resolve inside the export to a regular file. An asset path is `assets/<md5>` or `www.bundle/<md5>.<ext>` (DOM
components), the MD5 is its key, and the file's bytes must hash to it. Repeated identical entries collapse.

Steps, in order; every refusal comes before the first write, and all replies are signed in memory first:

1. Read the config, runtimes and export, and open the writer (Keys).
2. Refuse an asset key recorded for another SHA-256 in any retained release record or registered build (P5), or in
   two of them, comparing keys case-insensitively. An unreadable record refuses too.
3. Read each pointer and its ETag, then the bucket's time. Refuse a local clock more than a minute from it, or a
   certificate invalid by either clock.
4. Compose each platform's manifest under a fresh UUID with `createdAt = max(now, previous createdAt or commitTime
   + 1 ms)`, one clock sample for all; metadata `channel`, filter `channel="<channel>"`. Sign the exact part bytes
   (RSA PKCS#1 v1.5, SHA-256) through the key source, and build `reply/no-update` if it is missing.
5. (P5) Build `BSDIFF40` patches from every registered base for the runtime and platform (embedded builds plus the
   last N updates); apply each and check its hash before upload; keep one only if it is well under the compressed
   bundle.
6. Upload missing `bundles/` and `assets/` (put-if-absent; a lost race stored the same bytes), then
   `reply/no-update` (a winner must verify under the identity), release records, and (P5) bases and patches. Then,
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

**Rollback and republish.** Both run only `expo config --json` (with the Expo environment above) for the
identity, need no `TIDE_SERVER_URL` or `TIDE_ASSET_URL`, and share publish's exit codes, clock and certificate checks,
`reply/no-update` repair and pointer writes. Every refusal, including each argument rule below, comes before the
first write; arguments are checked before Expo runs.

- `tide rollback --embedded --channel <name> --runtime-version <v> [--platform ios|android]... [--project-root <dir>]`
  writes, per platform, a signed `rollBackToEmbedded` with `commitTime = max(now, previous createdAt or commitTime +
  1 ms)`. The runtime is given, never resolved, and the pointer must exist: a typo must not pass for a rollback. It
  has no release record and no `expo-manifest-filters`. stdout: `<key> - <commitTime>`.
- `tide republish <updateId>... [--channel <name>] [--runtime-version <v>] [--project-root <dir>]` serves each
  update's stored code again under a fresh UUID, on `--channel` or the update's own channel. It is rebuilt from the
  release record by publish's own manifest builder, so hashes, keys, extensions, `extra` and URLs are the original's;
  only the ID, `createdAt = max(now, previous + 1 ms, source createdAt + 1 ms)`, `metadata.channel` and the filter
  change. It writes a new release record and uploads nothing. stdout as publish.
- `tide rollback --to <updateId> [--to <updateId>]... [--project-root <dir>]` is `republish` onto each update's own
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
- `legacy/map.json`.

A name outside the key grammar prints as a JSON string with every character outside printable ASCII written `\uXXXX`.
It writes nothing and takes no lock, so the report is exact for a quiescent bucket: a record committed after the
listing protects its content only from the next run. Exit 0 with the report; 1, with nothing on stdout, when a
listing or read fails or a record or the legacy map does not decode; 2 on a usage or configuration error.

`register-build` (P5) records a store build's embedded update ID and bundle as a base.

**Nothing is deleted.** The protocol requires a published asset URL to keep working, release records back the asset key
identity check, and storage is cheap (about 2 GB for 100 updates of a 10 MB bundle on two platforms). Deleting from an
object store safely while writes can land late would need machinery Tide does not want; if storage ever matters,
deletion gets its own design.

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

**Identity.** The app config gives the certificate (`updates.codeSigningCertificate`, relative to the project root)
and `updates.codeSigningMetadata`. `keyid` is required, since Expo's implicit `root` is refused, and `alg` must be
absent or `rsa-v1_5-sha256`. The certificate must be one ASCII PEM block, each delimiter alone on its line, holding
one self-signed X.509 v3 certificate, valid now, signed with `sha256WithRSAEncryption` (the same identifier inside and
outside the TBS), with well-formed Key Usage `digitalSignature`, Extended Key Usage `codeSigning`, no repeated
extension, no Expo project-information extension, and an RSA key of 2048 to 4096 bits.

**Build pins.** The checkout can drift from what installed builds embed, so two required variables record the store
builds' identity, read from a shipped binary rather than the checkout:

- `TIDE_BUILD_KEYID`: the builds' `keyid`.
- `TIDE_BUILD_CERTIFICATE_SHA256`: SHA-256 of the builds' certificate DER, 64 hex digits, colons allowed.

In an APK, `aapt2 dump xmltree --file AndroidManifest.xml app.apk` shows the meta-data
`expo.modules.updates.CODE_SIGNING_CERTIFICATE` and `CODE_SIGNING_METADATA`; in an IPA, `plutil -p
Payload/<App>.app/Expo.plist` shows `EXUpdatesCodeSigningCertificate` and `EXUpdatesCodeSigningMetadata`. Get the
fingerprint with `openssl x509 -noout -fingerprint -sha256`. The app config must match both pins; a renewed
certificate does not pass while the builds hold an expired one.

**Probe.** Before the bucket is opened, the CLI signs `tide signing probe` and verifies it against the certificate
and `keyid`. Every later signature is verified the same way before it is returned, so a re-pointed KMS alias cannot
produce a part the app rejects. Every key or config refusal exits before the bucket is opened; the bucket check only
reads replies. Each refusal has a fixed message that names variables and config fields, never a key,
credential or provider text.

**One signing identity per bucket.** Every build a bucket serves gets the same signed `reply/no-update`. When it
exists, the CLI requires its directive to be a signed `noUpdateAvailable` that verifies under the configured
certificate and `keyid`. When it is absent, every entry under `reply/` must be a pointer whose signed part verifies
the same way (an empty `reply/` is a new bucket), so no writer repairs another identity's bucket. A new key or key
ID therefore needs a new bucket and `updates.url`. `publish`, `rollback` and `republish` create a missing
`reply/no-update` with put-if-absent before any pointer and re-check a winner they did not write; they re-check the
certificate's validity by both clocks after signing and, once a write has been attempted, before each pointer
write; and they run Expo's tools with every `TIDE_` variable removed and `EXPO_NO_DOTENV=1`, so no signing or
storage secret reaches project code.

**KMS provisioning.** KMS cannot export a private key, so the self-signed certificate is made offline and the key
imported:

1. `npx expo-updates codesigning:generate`, then `openssl pkcs8 -topk8 -nocrypt -outform DER` on the private key.
2. `aws kms create-key --origin EXTERNAL --key-spec RSA_2048 --key-usage SIGN_VERIFY` (the spec matching the key).
3. `get-parameters-for-import --wrapping-algorithm RSA_AES_KEY_WRAP_SHA_256`, wrap the DER, and
   `import-key-material --expiration-model KEY_MATERIAL_DOES_NOT_EXPIRE`.
4. Keep one encrypted recovery copy of the private key offline, outside AWS: if the imported material is deleted,
   only the same material restores signing for installed builds. Delete every other copy.

## Observability

One analytics data point per `/manifest` (runtime, platform, current and embedded IDs, recent failed update IDs,
fatal-error flag), and a synthetic probe that verifies a manifest's signature against a pinned certificate and
fetches its bundle.

## Later

- Certificate chains: the CLI validates and serves a leaf plus intermediates, so the key can rotate without an app
  release.
- A KMS-signed self-signed certificate, so the key never exists outside KMS.
- Staged rollouts: a percentage in the pointer, a hash of `EAS-Client-ID`, two pre-signed bodies.
- Hermes delta compiles (`hermesc -base-bytecode`), measured against plain bsdiff.
