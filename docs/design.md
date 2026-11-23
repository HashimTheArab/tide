---
status: draft
updated: 2026-11-23
---

# Design

Tide serves Expo Updates protocol v1 to stock `expo-updates` clients. The CLI builds, signs and uploads every
reply ahead of time; the server picks a stored reply from request headers and streams it. Decisions behind this are
in [0001](decisions/0001-architecture.md).

## Client rules the design follows

Tide requires code signing. Apps must ship a code-signing certificate (`updates.codeSigningCertificate`), and the
CLI refuses to publish without a key. Without it, anyone who can write the bucket could make apps run their code.

- A client checks on launch (and, depending on the app, on foreground) and never needs the server to start.
- It ignores a manifest that fails the response's `expo-manifest-filters`. Otherwise it applies the manifest when its
  `createdAt` is newer than the update it runs, or whatever its age when the running update fails those filters
  (expo-updates' filter-aware selection policy; a `rollBackToEmbedded` directive follows the same rule). So a
  rollback is a new, newer publish, and a device must never be served an older reply whose filters its running
  update fails.
- It verifies `expo-signature` over the exact bytes of the multipart part, and each asset's SHA-256.
- In chain mode it builds the chain from the reply's `certificate_chain` part (leaf first) and the embedded
  certificate as root, checks every certificate's validity at request time, links and CA constraints, and ignores the
  signature's `keyid`. The protocol package's `certificateChain` mirrors those rules, stricter where its comments
  say. The app opts in natively (Android meta-data
  `expo.modules.updates.CODE_SIGNING_INCLUDE_MANIFEST_RESPONSE_CERTIFICATE_CHAIN`, iOS `Expo.plist`
  `EXUpdatesCodeSigningIncludeManifestResponseCertificateChain`); in SDK 58 no app-config field maps to either, so a
  config plugin writes them.
- Every signing client sends `expo-expect-signature` with its metadata `keyid` (`root` when absent), chain mode
  included.
- It checks signatures only at download. The launcher picks the newest downloaded update whose runtimeVersion matches
  the build and never verifies it again, so a build that switches signing identity needs a new runtimeVersion
  ([0003](decisions/0003-one-identity-per-runtime.md)).
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
reply/no-update                          stored reply: the signed noUpdateAvailable, or one per keyid
legacy/map.json                          content keys that URLs from earlier servers name (legacy import)
bases/<updateId>                         base record: a launch bundle patches start from (Base records)
patches/<fromHash>/<toHash>              BSDIFF40 patch between two launch bundles (Patches)
identities/<sha256(keyid)>               the root a chain-mode keyid is bound to (Keys); the server never reads it
```

The server's credentials are read-only, with one exception: a Workers R2 binding cannot be made read-only, so the
Worker holds write access it never uses. Its store type admits only `get`, and only `src/workers.ts` touches the
binding. Code running inside the Worker could delete objects; it could not make a write pass the client's signature
and hash checks. An operator who needs a strictly read-only Worker can point the S3 adapter at R2's S3 API with a
read-only token.

- **Keys** are a known prefix plus a hash (`assets/` or `bundles/` and 64 lowercase hex), a release record
  (`updates/<lowercase UUID>.json`), a base record (`bases/<lowercase UUID>`), a patch (`patches/` and two 64
  lowercase hex content keys, from then to), an identity binding (`identities/` and the 64 lowercase hex SHA-256 of
  the keyid's UTF-8) or a reply key. All but reply keys are lowercase, so they are distinct on
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
- Any other `version` is unreadable. A new layout bumps it, and no CLI may write it before every server sharing the
  bucket reads it ([release.md](release.md), [deploy.md](deploy.md#upgrade-order)).
- The bucket is trusted, so neither codec nor server checks signatures, framing or that fields agree with the body.
  The publisher builds the record from what it has just built and signed: the boundary `encodeMultipart` returned,
  the kind of the part it built, `updateId` from the signed manifest's `id`, and the key's runtime from its
  `runtimeVersion`. Each filter member is a signed metadata member (key lowercased, same value), so the client's
  filter check passes. Metadata keys must stay distinct after lowercasing and Unicode canonical equivalence (NFC):
  iOS compares Swift strings that way and traps on duplicate dictionary keys.
- A publish replaces a record whole (R2 and S3 atomically; on disk a temporary file and a rename), so a request reads
  the old reply or the new one, never a mix.

A pointer may instead hold a version-2 rollout record, encoded by `encodeRollout` and read with `decodePointer`, which
reads both versions; `decodeStoredReply` reads version 1 only, so `reply/no-update` can never hold a rollout. Keys in
this order, no whitespace, no trailing newline:

```json
{"version":2,"kind":"rollout","percent":12.5,"new":{"kind":"manifest","updateId":"<uuid>","contentType":"…","manifestFilters":"…","body":"…"},"earlier":{"kind":"rollBackToEmbedded","contentType":"…","body":"…"}}
```

- `percent` is a JSON number from 0 to 100 in steps of 0.01.
- `new` and `earlier` hold the version-1 fields without `version`. `new` is a manifest. `earlier` is a manifest with
  another update ID, a `rollBackToEmbedded`, or `null` for the stored `reply/no-update`; never `noUpdateAvailable`.
- Decode refuses any record encode would not write byte for byte: another key order, whitespace, escape or number
  spelling, an unknown or missing field, or a record over 2 MiB. Both bodies are the exact signed bytes, carried as
  strings like a version-1 body.
- Only `tide publish --rollout` and `tide rollout` write version 2 (CLI, Staged rollouts); servers read it from the
  same release, and must be deployed first.

#### Several signing identities (version 3)

One signing identity per runtime ([0003](decisions/0003-one-identity-per-runtime.md)): a pointer holds one identity's
replies, and only `reply/no-update`, which every runtime shares, may hold a version-3 record with one entry per
signing identity, keyed by the keyid its builds send in `expo-expect-signature`. Protocol `encodeIdentityNoUpdate`
writes it and `decodeNoUpdate` reads it beside version 1; `decodePointer` and `decodeStoredReply` refuse it. Golden
file: `identities-no-update.reply.json`. Each entry is `keyid` followed by the fields of a version-1
`noUpdateAvailable` reply without `version`:

```json
{"version":3,"identities":[{"keyid":"main","kind":"noUpdateAvailable","contentType":"…","body":"…"},{"keyid":"root","kind":"noUpdateAvailable","contentType":"…","body":"…"}]}
```

- An array, sorted by keyid in code-unit order, each keyid once, 1 to 16 entries, each a `noUpdateAvailable`.
- A keyid is non-empty printable ASCII whose escaped length (each `"` and `\` counts twice, the same in JSON and in
  the RFC 8941 header string) is at most 4 KiB, leaving room in Node's default 16 KiB request head for the
  `expo-expect-signature` syntax and a stock client's other headers. Protocol `checkKeyId` applies the one rule to
  records, requests and the keyids the CLI accepts.
- Size: at most 2 MiB plus 8 KiB. The margin lets any valid version-1 `reply/no-update` become a one-entry record
  under any keyid, body bytes unchanged.
- Decode refuses anything encode would not write byte for byte, as for version 2, naming the field where it can.

Migration rules, for the writers:

- A version-1 or version-2 record counts as the one identity its signatures carry, and the server serves it to every
  request whatever the keyid, so buckets written before version 3 keep serving the same bytes.
- Only `tide publish --add-identity` converts a version-1 `reply/no-update`: the existing reply is kept byte for byte
  under the keyid its `expo-signature` names, beside the new identity's. A legacy keyid over 4 KiB keeps serving, but
  cannot be converted.
- Servers first, and every writer's CLI: an older server answers 503 wherever a request needs a version-3
  `reply/no-update`, and an older CLI refuses to write over one ([deploy.md](deploy.md#upgrade-order)).

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
6. A rollout pointer picks a side, then the reply on that side, as below.
7. `Expo-Current-Update-ID` equal to the update ID of the manifest picked (compared ignoring case), or no reply on
   the side picked: the stored `reply/no-update`.
8. Otherwise the reply picked. A rollback is served even to a client running its embedded update: the client applies
   it when its `commitTime` is newer than the running update's, and applying it stops an OTA update it already
   downloaded from launching next.

A rollout's side:

- 100% is `new` for every request. Otherwise a request without a usable client ID gets `earlier`. A usable client ID
  is an `EAS-Client-ID` holding exactly one UUID, in any case; both platforms send a per-install UUID on every
  manifest request. Empty, malformed and repeated (joined) values are unusable.
- Otherwise the bucket is the first 4 bytes (big-endian) of SHA-256 over `<new update ID>:<lowercased client ID>`,
  mod 10,000, and the side is `new` when the bucket is below `percent × 100`. So 0% is `earlier` for every request,
  a device keeps its side while the percentage does not drop, raising it only adds devices, and each rollout
  reshuffles which devices go first. Protocol `rolloutSide` is the one implementation.
- A device whose `Expo-Current-Update-ID` is the new update gets `reply/no-update` on either side. The earlier reply
  can carry filters the new update fails (another branch, or a rollback), and the client would then apply it
  whatever its age (Client rules). Step 7 still applies on the side picked, so a device on the earlier manifest gets
  no-update on the earlier side.
- So 100% serves exactly what a version-1 pointer to the new reply serves, and 0% exactly what a version-1 pointer to
  the earlier reply (or no pointer, when it is absent) serves, except that a device on the new update gets no-update.
  Lowering the percentage never moves a device back: devices already on the new update stay there. To move them off
  it, publish a newer update or use `tide rollback`.

A pointer is served to every request alike: one runtime has one signing identity, and a chain-mode client ignores the
signature's keyid anyway. A version-3 `reply/no-update` serves the entry of the request's keyid: the `keyid` string of
its `expo-expect-signature`, or `root` when it has none, since every signing stock client sends the header, in chain
mode too. The keyid is read only when a version-3 `reply/no-update` decides the reply, so version-1 records serve
exactly as before, whatever the header says.

- An absent or malformed header, or a keyid that is not a string `checkKeyId` accepts: 400 with exactly
  `expo-expect-signature must name a keyid`.
- No entry for the keyid: 404 with exactly `no reply is signed for this keyid`. Neither body names the keyid or holds
  stored bytes.

A served reply is 200 with the stored body, `content-type: multipart/mixed; boundary=…`, `expo-protocol-version: 1`,
`expo-sfv-version: 0`, `cache-control: private, max-age=0`, and, for a manifest only, the served manifest's stored
`expo-manifest-filters` (even when empty: a client keeps earlier filters when the header is absent). Each part
carries `Content-Disposition: form-data; name="manifest"` (or `"directive"`), `Content-Type: application/json` and
`expo-signature: sig="<base64>", keyid="<id>"` over its exact bytes.

A reply picked by keyid also carries `vary: Expo-Expect-Signature`, so a private cache (Android's OkHttp) never
gives one identity's reply to another. Legacy responses carry no `vary`, but `max-age=0` makes a cache revalidate
them, and with no validator that is a full request. An app whose `requestHeaders` allow stale responses
(`max-stale`) must also send `cache-control: no-cache` from the build that moves to a new identity.

One deadline (10 s) covers every read of a request. A missing `reply/no-update` when it is needed, a record over its
limit (2 MiB for a pointer, the version-3 limit for `reply/no-update`; checked from its stored size before reading),
one that fails to decode (a malformed or oversize version-2 or version-3 record, and a version-3 record at a pointer
key, included) or has the wrong kind for its key, a store error, and a read past the
deadline are each 503 with `cache-control: no-store`; 400, 404 and 406 are `no-store` too, and record no analytics
point. A server older than a record's version answers 503 for it.

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

**One writer at a time.** `publish`, `rollout`, `rollback`, `republish` and `register-build` run only as CI jobs in one
concurrency group (for example `concurrency: tide-publish`) that runs them one at a time (`deploy.md`, Publishing). There is no lock
object: a lease lock in a bucket cannot stop a delayed write from landing after another writer takes over. As a
backstop, the pointer write is conditional, so an accidental second writer fails cleanly instead of overwriting.
Writers of every keyid share the bucket's one group: the asset key check spans every identity's records, and its
writes are not conditional.

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

`tide status [--json]` prints one line per pointer (`<channel> <runtime> <platform> <kind> <updateId|-> <createdAt|commitTime>`,
read from the stored signed part without re-serialising it) and whether `reply/no-update` is present, unreadable or
missing. A rollout prints `<channel> <runtime> <platform> rollout <percent> new <updateId> <createdAt> earlier <kind>
<updateId|-> <createdAt|commitTime>`, or `earlier none`, with both sides checked. A version-3 `reply/no-update` prints
`reply/no-update keyid "<keyid>": present` (JSON-quoted) per entry in keyid order, and is unreadable when any entry
is, or when an entry is signed under another keyid than its own. A version-3 record at a pointer key is unreadable. It exits 1 if any record is unreadable, and 2 on a configuration or listing error. An unreadable record is
reported by its key, the same name a readable row prints, with a fixed reason; a name outside the key grammar and a
stored field are never printed.

**Project code.** Only `tide export` runs project code, and it reads no credential; the writers (`publish`,
`rollout`, `rollback`, `republish`, `register-build`) start no process. A child of a process holding a key could read it as the
same user, so no environment allowlist would protect a writer that ran Expo.

`tide export --out <dir> [--platform ios|android]... [--runtime-version <v>] [--project-root <dir>]
[--pass-env <name>]... [--base-bytecode <platform>=<file>]` writes the export directory `publish --from` reads. `--out` and `--project-root` resolve
against the caller's directory; `--out` must not exist. Platforms default to both. Exit 0, or 2 on any refusal or
tool failure; stdout has one `<platform> <runtimeVersion>` line per platform.

1. `expo config --json` gives `updates.codeSigningMetadata` (`keyid` required, as `checkKeyId` allows, `alg` absent or
   `rsa-v1_5-sha256`; only those two members are kept) and `updates.codeSigningCertificate` (relative to the project
   root, a regular file of at most 64 KiB, UTF-8, passing the certificate profile, so it holds one certificate and
   nothing else). `updates.codeSigningIncludeManifestResponseCertificateChain` (the input of the app's own config
   plugin, which `expo config` passes through) must be absent or a boolean; when `true` the certificate must pass the
   root rules instead (Keys, Chain mode).
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

Chain mode adds `"codeSigningIncludeManifestResponseCertificateChain":true` after `codeSigningMetadata`; it is
written only when true, so a direct export's bytes are unchanged, and an older CLI refuses the member rather than
publish direct-signed.

Everything in the directory is served publicly (`expoClient` is every manifest's `extra.expoClient`; `dist` is what
is uploaded) or embedded in every shipped build (certificate, `keyid`, `alg`). Steps 1 and 2 refuse before `<dir>`
is created.

**Expo.** `expo` and `expo-updates` run from the nearest `node_modules/.bin` at or above the project root, with no
shell and an allowlisted environment: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `CI`,
`EXPO_PUBLIC_*` (Expo inlines them into the bundle), each `--pass-env` name (never a `TIDE_`, `AWS_` or `ACTIONS_`
one), `EXPO_NO_DOTENV=1`, `NODE_ENV=production` and `BABEL_ENV` as given or, when unset or empty, `production`: the
mode `expo export` forces, so config, runtime and bundle agree.

**Delta compiles** ([0002](decisions/0002-hermes-delta-compiles.md)). `--base-bytecode <platform>=<file>` has Expo
compile the launch bundle against `<file>`, the release build's embedded bundle, so patches from every base shrink.
Expo gives hermesc no platform, so a based export selects that one platform, and each platform is exported on its
own. Publish, patches and the wire format do not change. Without it the export runs no hermesc of its own and its
bytes are unchanged.

1. Before any child: the file (against the caller's directory) is a regular file opening with the HBC magic
   `c6 1f bc 03 c1 03 19 1f` and a u32 little-endian bytecode version at offset 8. `--pass-env
   REACT_NATIVE_OVERRIDE_HERMES_DIR` is refused: a based export compiles with the hermesc 0002 names.
2. Before any Expo tool and before `<dir>` exists: the app's hermesc, found as `@expo/metro-config`'s
   `exportHermes.js` finds it: `react-native/package.json` resolved from the real project directory,
   `hermes-compiler/package.json` from react-native's, then the first of
   `<react-native>/ReactAndroid/hermes-engine/build/hermes/bin/hermesc`, `<hermes-compiler>/hermesc/<host>/hermesc` and
   `<react-native>/sdks/hermesc/<host>/hermesc` (`osx-bin` or `linux64-bin`; no Windows). Its `-version` must print
   `HBC bytecode version: <n>` equal to the base's.
3. `expo export` gets `REACT_NATIVE_OVERRIDE_HERMES_DIR` naming a `sh` wrapper that runs that hermesc with Expo's
   arguments plus `-base-bytecode=<copy of the checked bytes>`, so Expo writes, names and lists the delta bundle
   itself. Every chunk Expo compiles is compiled against the base. hermesc gets the environment Expo's tools get.
4. After the export is read: the wrapper must have run, and the launch bundle must be HBC of the base's version. A
   refusal here leaves no `tide-export.json`.

`tide publish --from <dir> --channel <name> [--rollout <percent>] [--add-identity]` publishes one update per platform
the export names (`--rollout`: Staged rollouts; `--add-identity`: Keys, One signing identity per runtime). Exit 0 means every pointer was written, 2 that the publish was refused before any write, 1 that it failed after writes began. stdout has
one line per pointer written: `<key> <updateId> <createdAt>`. Every writer but `register-build` takes `--json`
(JSON output).

**Configuration.** `TIDE_SERVER_URL` (the Tide server) and `TIDE_ASSET_URL` (the bucket's public domain) are each an
absolute `https:` URL with no credentials, query or fragment, or `http:` to a loopback IP literal; a trailing `/`
is dropped. Plus the bucket (Bucket configuration) and a key (Keys).

**URL shapes**, permanent once published (no extension: the client names files by `key` and `fileExtension`):

- launch asset: `<TIDE_SERVER_URL>/bundles/<64 hex>`;
- asset: `<TIDE_ASSET_URL>/assets/<64 hex>`. Byte-identical files with two extensions share one object and its
  first upload's `Content-Type`; clients check the hash, not the type.

**Export.** The directory is untrusted input, checked once, by publish. `tide-export.json` (at most 16 MiB, UTF-8
JSON) holds exactly the fields above with `version` 1, a string certificate of at most 64 KiB, an object
`expoClient`, the chain member only as `true` (absent is direct), and one or more of `ios` and `android`, each only
a `runtimeVersion` the key grammar accepts. Its certificate must be the builds' (same DER), its `keyid` and mode
theirs (Keys). Neither it nor `dist` may resolve outside
the directory, which must stay unchanged while publish runs. Every path in `metadata.json` must resolve inside
`dist` to a regular file. An asset path is `assets/<md5>` or `www.bundle/<md5>.<ext>` (DOM
components), the MD5 is its key, and the file's bytes must hash to it. Repeated identical entries collapse.

Steps, in order; every refusal comes before the first write, and all replies are signed in memory first:

1. Read the export and open the writer (Keys).
2. Refuse an asset key recorded for another SHA-256 in any retained release record or registered build, or in
   two of them, comparing keys case-insensitively. An unreadable release or base record refuses too.
3. Read each pointer and its ETag, and refuse a runtime and platform that another keyid's pointer holds (Keys, One
   signing identity per runtime). Then read the bucket's time; refuse a local clock more than a minute from it, or a
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
   build `reply/no-update` if it is missing, holds no entry for this keyid (`--add-identity`), or in chain mode serves
   this keyid another chain than the configured one, and re-check the certificate by both clocks.
6. Upload missing `bundles/` and `assets/` (put-if-absent; a lost race stored the same bytes), then kept patches
   at `patches/<from hex>/<to hex>` (put-if-absent, `no-store`; a lost race stored the same deterministic, checked
   bytes), then in chain mode the identity binding (put-if-absent; a winner must bind the same root), then
   `reply/no-update` (put-if-absent, or `If-Match` on the record read; in chain mode the chain is re-checked by both
   clocks just before it), then each release record followed by its `update` base record (put-if-absent). A lost
   `reply/no-update` race is kept only when the winner needs no change from this writer (this identity's entry, and in
   chain mode the configured chain), judged without signing; otherwise the publish exits 1 and its rerun writes over
   the winner. A patch that lands late is harmless: no pointer names its target yet.
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
`TIDE_SERVER_URL` or `TIDE_ASSET_URL`, and share publish's exit codes, clock and certificate checks, runtime check,
`reply/no-update` repair and pointer writes. They take no `--add-identity`. Every refusal, including each argument rule below, comes before the
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

**Staged rollouts.** `tide publish ... --rollout <percent>` composes and signs as publish does, then writes each
pointer as a version-2 rollout record (Stored replies). `new` is the reply just signed. `earlier` is the exact stored
reply the pointer held (a manifest or a rollback), a complete rollout's new reply (what every device was getting), or
none when there was no pointer, so devices outside the rollout get `reply/no-update`. Over any other rollout it
refuses: finish that one with `tide rollout complete`, or replace it with a plain publish, republish or rollback. A
percentage is 0.01 to 99.99 in steps of 0.01, written as a plain decimal (`12.5`); 0 and 100 are `revert` and
`complete`. A value starting with `-` is a usage error, since the argument parser reads it as an option. The record
must fit the size limit at `99.99`, the longest percentage, so `tide rollout` can always move it. stdout and exit
codes as publish.

`tide rollout <percent>|complete|revert --channel <name> --runtime-version <v> [--platform ios|android]...` rewrites
each existing rollout from its stored bodies, byte for byte, and signs nothing: it reads the build pins (Keys) and
needs no key, and refuses a bucket whose `reply/no-update` is absent or holds no entry of this identity. `complete`
writes the record at 100%, which serves exactly what a version-1 pointer to the new reply serves (GET /manifest).
`revert` writes it at 0%: every device gets the earlier reply, or `reply/no-update`, except a device already running
the new update, which keeps getting signed no-update and stays on it. A version-1 pointer to the earlier reply would
drop that guard, and Expo's filter-aware selection would then move only some of those devices back. To move them all
off the new update, use `tide rollback --to <earlier updateId>` or `--embedded`, or publish a fix. Both records keep
the new update's `createdAt`, so later writers still stamp after it. stdout, one line per platform whether written or
not: `<key> <new updateId> <percent>`. Exit codes as publish: 0, 2 refused before any write, 1 after.

- **Forward only.** A percentage only rises. The same percentage writes nothing, and a lower one refuses: lowering
  never moves a device back, since a client applies only a newer `createdAt`, so use `revert` or `tide rollback`.
  `complete` and `revert` end a rollout; rerunning either writes nothing and any other rollout command refuses. The
  rollout commands stamp no time, and disk ETags (SHA-256) and S3 and R2 single-part ETags (MD5) are content hashes,
  so this rule is what keeps a key from returning to bytes it held: a delayed PUT conditioned on an earlier record's
  ETag can then never land over a later identical one.
- **Copied bodies are verified.** Every body a write copies (both sides for `tide rollout`, the kept reply for
  `publish --rollout`) must verify under the configured certificate and `keyid`, whatever `reply/no-update` holds.
  Plain publish, republish and rollback copy nothing, so they still replace a pointer that fails; that repairs it.
- **A rise checks the new reply.** In chain mode, a higher percentage or `complete` refuses (exit 2) when the new
  reply's chain fails the client's rules by either clock, read after the pointers, since it would reach devices the
  earlier reply served. Before each later rising write, both clocks are read afresh again; a failure then exits 1.
  `revert` and a target already at its goal restore or keep what devices get, and read no clock.
- **Replaced whole.** A plain publish, republish or rollback over a rollout, active, complete or reverted, writes a
  version-1 reply stamped after both of its sides: a pointer's time is the newest time it holds.
- **Retry.** Each command converges under the writer job's retry loop (`deploy.md`, Publishing). `tide rollout`
  writes nothing to a target already at its goal. `publish --rollout` skips a target whose unfinished rollout is at the
  same percentage and whose new update's release record is the one this export would write there (same code, channel,
  URLs and `expoClient`), once both its sides verify, and prints that target's stored line; at another percentage it
  refuses. So a rerun after a partial write, or after a committed PUT whose response was lost, writes only the
  targets left.
- **Probe.** `tide probe` sends no `EAS-Client-ID`, so below 100% it checks the earlier side. With `--rollout-side new
  --rollout-update <updateId>` it checks the new one (`tide probe`).

`tide storage [--json]` reports, read-only, every object under `assets/`, `bundles/` and `updates/` that nothing
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
pins (Keys) before the bucket is opened and refuses a bucket whose `reply/no-update` is absent or holds no entry of this
identity: a build is registered only where its own certificate and `keyid` are already served, so a first publish
cannot pin another identity over its asset keys. It also refuses a runtime and platform that another keyid's pointer
holds on any channel (Keys, One signing identity per runtime), so a build reusing another identity's runtime is caught
before it ships. Exit codes as publish; stdout `bases/<id> bundles/<64 hex>`.

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
  a missing or invalid build pin; a bucket with no `reply/no-update` or none of this identity; a runtime and platform
  another keyid's pointer holds;
  an ID that is not a lowercase UUID; an unreadable input; an asset key with no matching file; an asset key that a
  release record or another registered build records with another SHA-256; and a `bases/<id>` holding other bytes.
- **Writes**: `bundles/<hex>` put-if-absent (immutable, `application/javascript`), then `bases/<id>` put-if-absent.
  A lost base create succeeds only if the stored bytes are identical. Re-running with identical inputs writes nothing
  and exits 0. An unknown outcome exits 1, and the retry starts from the bucket (One writer at a time).

**Nothing is deleted.** The protocol requires a published asset URL to keep working, release records back the asset key
identity check, and storage is cheap (about 2 GB for 100 updates of a 10 MB bundle on two platforms). Deleting from an
object store safely while writes can land late would need machinery Tide does not want; if storage ever matters,
deletion gets its own design.

### JSON output

`status`, `storage`, `probe`, `stats`, `publish`, `rollout`, `rollback` and `republish` take `--json`: stdout is then one
JSON document on one line, and stderr and the exit code are what they are without it. Every character outside printable
ASCII is written `\uXXXX`, so no stored byte reaches a terminal raw.

`schema` numbers each command's document on its own (the four writers share one); every one is 1. It changes when a
field is removed, renamed, moved, or changes type or meaning, or a listed set of values gains a member. A field added
at the end of its object does not change it, so readers ignore fields they do not know. Every field below is always
present, in this order; `null` means it does not apply.

| Document | Fields |
| --- | --- |
| `status` | `schema`, `pointers`, `noUpdate`, `unreadable` |
| one of `pointers` | `key`, `channel`, `runtimeVersion`, `platform`, then a side's fields, or `kind` (`rollout`), `percent`, `new` (a side), `earlier` (a side, or `null` for none) |
| a side | `kind` (`manifest` or `rollBackToEmbedded`), `updateId` (`null` for a directive), `time` (`createdAt` or `commitTime`), `keyid` (the one its signature names) |
| `noUpdate` | `state` (`present`, `missing` or `unreadable`), `version` (1, 3 or `null`), `entries` (one `{"keyid"}` per entry, in keyid order) |
| one of `unreadable` | `key` (`null` for a name outside the key grammar), `reason` (stderr's) |
| `storage` | `schema`, `unreferenced`, `count`, `totalBytes` |
| one of `unreferenced` | `name`, `isKey` (false for a name outside the key grammar), `size` |
| `probe` | `schema`, `failure` (`null`, or the class under `tide probe`), `rolloutSide` (`new` with `--rollout-side new`, else `null`), `directive`, `updateId`, `launchAssetHash` (all `null` on a failure) |
| `stats` | `schema`, `windowHours`, `currentUpdates`, `failedUpdates`, `rolloutSides`, `verdict` (a report's three groups or the verdict, the rest `null`) |
| `currentUpdates`, `failedUpdates`, `rolloutSides` | `truncated`, `counts` (one `{"updateId", "checks"}`, or `{"side", "checks"}`, per line of text; the name is `null` where the line has `-`) |
| `verdict` | `updateId`, `maxFailedShare`, `minChecks`, `result` (`ok`, `bad` or `notEnoughChecks`), `failedChecks`, `checks` |
| the writers | `schema`, `complete`, `pointers` |
| one of a writer's `pointers` | `key`, `updateId` (`null` for a directive), then `time`, or for `rollout` `percent` |

- **Sizes.** `size` and `totalBytes` are decimal strings, since a JSON number past 2^53 is not exact.
- **Keyids.** A pointer's keyid is its own; nothing names one for the bucket
  ([0003](decisions/0003-one-identity-per-runtime.md)).
- **Nothing printed.** Exit 2 of any command, a failed `storage` scan, and every `stats` exit but 0 and 10 leave stdout
  empty. `status` prints its document with exit 1 when a record is unreadable, and `probe` on every failure but 2.
- **Writers.** Exit 0 or 1 prints the document. `pointers` holds exactly the pointer writes this run made and the
  bucket acknowledged, in write order, so a target already as asked is not listed, nor is one whose write lost its race
  or has an unknown outcome. `complete` is true only with exit 0; a crash while writing prints it as false. Each attempt
  of a retry loop prints its own.

### `tide certificate`

`tide certificate` prints a certificate signed by the configured key source (Keys), so a key created inside KMS
needs no copy anywhere else. It reads only the key-source variables and the files its flags name: no build pins, no
bucket and no project code, and it opens no file for writing.

| Flags | Issues | Subject key | Signed by |
| --- | --- | --- | --- |
| `--common-name <name>` and a lifetime | the self-signed direct-signing certificate the app embeds | source's | source |
| `--ca [--path-length <n>]` with the above | a CA root, to embed for chain mode | source's | source |
| `--issuer <chain.pem> --subject-key <public-key.pem> --ca [--path-length <n>]` | an intermediate | the file's | source, as the issuer |
| `--issuer <chain.pem> --subject-key <public-key.pem>` | a leaf, the writer's chain-mode signer | the file's | source, as the issuer |

- **Arguments.** The common name is 1 to 64 printable ASCII characters with no space at either end. Every form takes
  exactly one of `--validity-years` (1 to 100) and `--validity-days` (1 to 36500), so a certificate can still be
  issued in an ancestor's last year. `--path-length` is 0 to 7, the most intermediates a served chain holds; absent
  means unlimited.
- **Inputs.** `--issuer` is a regular file of at most 64 KiB in the `certificate_chain` grammar: the issuing
  certificate first, each one above it, the root last (`cat intermediate.pem root.pem`, or `root.pem` alone).
  `--subject-key` is one canonical `PUBLIC KEY` PEM block holding an RSA SubjectPublicKeyInfo of 2048 to 4096 bits
  whose DER re-encodes byte for byte; `openssl pkey -pubout` writes it, and a KMS key's comes from
  `aws kms get-public-key`.
- **Certificate.** X.509 v3 with a random positive 16-octet serial, `sha256WithRSAEncryption` with NULL parameters
  inside and outside the TBS, and a subject Name holding only the common name. A self-signed certificate's issuer
  Name is the same bytes; an issued one's is the issuing certificate's subject Name, byte for byte. Validity runs
  to the same time `<n>` years later (29 February rolls to 1 March) or `<n>` × 86,400 s later, as UTCTime through
  2049 and GeneralizedTime from 2050. No form carries SKI, AKI or Expo project information.
  - Direct and leaf: Key Usage (critical) `digitalSignature` and Extended Key Usage `codeSigning`, nothing else.
  - Root and intermediate: Basic Constraints (critical) cA with the optional pathLen, and Key Usage (critical)
    `keyCertSign` only.
- **Clock.** The command reads the clock once. The direct form starts at that time in whole seconds. The chain
  forms start at the last whole second strictly before it, and every check runs at the sampled time: the client
  needs `notBefore < now < notAfter` on every chain member.
- **Signing.** The source signs the TBS as `publish` signs a part: KMS signs its SHA-256 with `Sign` (`DIGEST`).
  The public key comes from the PEM key, or from KMS `GetPublicKey` on the same request path as `Sign`. A reply is
  refused unless the key is `SIGN_VERIFY`, `RSA_2048`, `RSA_3072` or `RSA_4096`, allows
  `RSASSA_PKCS1_V1_5_SHA_256`, and its public key is an RSA SubjectPublicKeyInfo of that size.
- **Checks, before any output.**
  - Direct: the PEM passes the certificate profile (Keys), its public key is the source's, and `tide signing probe`
    signed by the source verifies under it, so a KMS key whose `Sign` and `GetPublicKey` disagree is refused.
  - Issued forms, before any key source call: both files parse, and the issuer path passes the client's chain rules
    as a CA path (`issuerPath`): at most 8 certificates, at most 32 KiB below the root, every member valid, linked
    and a CA with `keyCertSign`, and path lengths leaving room for the issuing certificate. `--subject-key` must
    differ from every key on the path, so a leaf never carries a CA's key. Then the issuing certificate's key must
    be the source's, and the new certificate must not expire after any certificate on the path. Keys compare as
    Web Crypto re-exports them, so another encoding of one key still matches.
  - After signing: a root or an intermediate, followed by its `--issuer`, passes `issuerPath` as the next
    `--issuer`; a leaf passes `certificateChain`, the client's chain-mode check, as the served part
    `leaf + intermediates` over the root. The link or root self-signature proves `Sign` and `GetPublicKey` agree,
    so they run no probe.
- **Output.** stdout is exactly the PEM, one block of 64-column lines; redirect it to a file outside the app
  checkout (`deploy.md`, Signing identity). stderr is `tide: certificate DER SHA-256 <hex>`, the fingerprint the
  identity check compares. Exit 0, or 2 on any refusal with nothing on stdout. No message carries a key,
  credential or provider text.

## Keys

A leaked key can ship code to every installed app. Publish only from CI, and sign through KMS where possible. In
direct mode the app embeds one self-signed certificate, and its key signs every part. In chain mode the app embeds a
CA root, and a leaf under it signs every part, served with its chain (Chain mode).

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

- `TIDE_BUILD_KEYID`: the builds' `keyid`, as `checkKeyId` allows. Expo's implicit `root` is never assumed.
- `TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN`: `true` for chain mode; `false`, unset or empty for direct, the client's
  default; anything else is refused.
- Exactly one of `TIDE_BUILD_CERTIFICATE_FILE` (a path, a regular file of at most 64 KiB) and
  `TIDE_BUILD_CERTIFICATE` (the PEM): the certificate, or in chain mode the root.

In an APK, `aapt2 dump xmltree --file AndroidManifest.xml app.apk` shows the meta-data
`expo.modules.updates.CODE_SIGNING_CERTIFICATE` and `CODE_SIGNING_METADATA`; in an IPA, `plutil -p
Payload/<App>.app/Expo.plist` shows `EXUpdatesCodeSigningCertificate` and `EXUpdatesCodeSigningMetadata`, and for chain mode
`CODE_SIGNING_INCLUDE_MANIFEST_RESPONSE_CERTIFICATE_CHAIN` and `EXUpdatesCodeSigningIncludeManifestResponseCertificateChain`.

**Certificate profile.** One ASCII PEM block, each delimiter alone on its line, holding one self-signed X.509 v3
certificate, valid now, signed with `sha256WithRSAEncryption` (the same identifier inside and outside the TBS), with
well-formed Key Usage `digitalSignature`, Extended Key Usage `codeSigning`, no repeated extension, no Expo
project-information extension, and an RSA key of 2048 to 4096 bits. A renewed certificate does not pass while the
builds hold an expired one.

**Identity.** `publish` also refuses an export whose `codeSigningMetadata` (`keyid` as `checkKeyId` allows, `alg`
absent or `rsa-v1_5-sha256`) names another `keyid`, whose mode differs from the pin, or whose certificate is not the
pinned one, compared by DER SHA-256.
`tide export` applies the same metadata rule and the profile before writing anything, so a malformed `keyid` or a
file holding a key never reaches an export.

**Probe.** Before the bucket is opened, the CLI signs `tide signing probe` and verifies it against the certificate
and `keyid`, or in chain mode under the served leaf. Every later signature is verified the same way before it is
returned, so a re-pointed KMS alias cannot
produce a part the app rejects. Every key, pin or export identity refusal exits before the bucket is opened; the bucket check only
reads replies. Each refusal has a fixed message that names variables and config fields, never a key,
credential or provider text.

**One signing identity per runtime** ([0003](decisions/0003-one-identity-per-runtime.md)). A store build that changes
its signing identity (a new key, certificate or root) ships under a new `keyid` and a new runtimeVersion, on the same
bucket and `updates.url`: the client never verifies a downloaded update again at launch (Client rules). Each writer's
identity check, before any write, reads only:

1. The binding key `identities/<sha256(keyid)>`. In chain mode it must bind this root (Chain mode). In direct mode it
   must be absent: only chain writers write one, so the keyid belongs to a chain root, perhaps one whose first publish
   stopped after binding.
2. `reply/no-update`. This keyid's reply in it (the version-1 record when its signature names this keyid, or this
   keyid's version-3 entry) must be a signed `noUpdateAvailable` that verifies under the configured certificate and
   `keyid` (in chain mode, that belongs to the identity). Without one, the writer is refused unless it is
   `tide publish --add-identity`, which then adds it, copying every other keyid's reply as stored. When
   `reply/no-update` is absent, every entry under `reply/` must be a pointer whose signed parts verify the same way,
   both bodies of a rollout included (an empty `reply/` is a new bucket), so only its own writer recreates it. A pointer
   signed under another keyid means a version-3 record was lost, which no writer can rebuild: every writer refuses and
   says to restore it ([deploy.md](deploy.md#adding-a-signing-identity)).
3. In chain mode, this keyid's replies without the binding refuse as lost (Chain mode).

Then `publish`, `republish`, `rollback` and `register-build` refuse a target runtime and platform that another
keyid's pointer holds on any channel, a rollout's either side included, judging the targets as it read them and
listing `reply/` once for the rest; an unreadable pointer of a target's runtime and platform refuses too, as its
owner is unknown. Pointers of other runtimes are never read. The check reads; it does not fence: a write landing
after the listing, or from a writer that skipped the check, is not seen, and the operator rule (a new runtimeVersion
per identity, one concurrency group) is what prevents it. `tide rollout` writes no new runtime and copies only its
target's bodies, each checked.

A direct keyid is its keyid plus its key, as in a single-identity bucket; a client accepts any certificate of the
same key. Chain-mode keyids keep their root binding (Chain mode).

`publish`, `rollback` and `republish` write `reply/no-update` with put-if-absent, or `If-Match` on the record read,
before any pointer, and keep a winner only when it needs no change from them; and they re-check the certificate's
validity by both clocks after signing and, once a write has been attempted, before each pointer write. No writer runs
project code (CLI).

**Chain mode.** The writers sign with a leaf under the pinned root, and every reply they build (manifest,
`rollBackToEmbedded`, `noUpdateAvailable`) carries the signed part followed by a `certificate_chain` part.

- **Root.** The pinned certificate is checked as the client reads a root: one PEM block, self-signed, valid now, a CA
  with `keyCertSign`, and no Expo project information. A chain-mode export's certificate must pass the same rules.
- **Served chain.** Exactly one of `TIDE_CERTIFICATE_CHAIN_FILE` (a path, at most 64 KiB) and
  `TIDE_CERTIFICATE_CHAIN` (the text): the leaf, then any intermediates, root excluded, in the `certificate_chain`
  grammar (at most 32 KiB and 8 certificates). It is not a pin, since leaves rotate without an app release; only
  `publish`, `rollback` and `republish` read it, and either variable in direct mode is refused. Its bytes are stored
  as given, after `certificateChain` passes them over the root at open, so the check runs on exactly what clients
  receive. The validity re-checks before each write cover every member of the chain.
- **Identity.** A stored body belongs to the identity when its signature's `keyid` is the pinned one, it carries a
  `certificate_chain` part (and a direct body none), and its chain links to the pinned root and verifies the
  signed part as of the chain's issue (`certificateChainAtIssue`: 1 ms after its latest `notBefore`). So a body an
  earlier leaf under the same root signed, expired or not, still belongs, and a new leaf needs no app release and no
  new bucket. The served chain omits the root, so the bucket also binds the `keyid` to the root's exact DER: the
  first chain-mode write creates `identities/<sha256(keyid)>`, `{"version":1,"keyid":"<keyid>","root":"<DER
  SHA-256 hex>"}`, with put-if-absent, and every writer refuses a binding to another root. A root reissued with the
  same subject and key is therefore another identity, with its own `keyid` and runtimeVersion: it could carry other
  constraints than the builds embed.
  Writers bind before any chained reply, so a bucket holding chained replies without the binding has lost it:
  every writer refuses it until the binding is restored, rather than bind whichever root its chains link to.
- **Shared no-update.** This keyid's `reply/no-update` reply carries the leaf that signed it, so a signing writer whose
  configured chain differs from the stored body's re-signs it, replacing only its own entry with `If-Match` on the
  ETag it read; a version-1 record stays version 1. A lost race keeps the winner only when it already serves the
  configured chain; an unknown outcome is re-read by the next run.
- **Expiry.** An expired leaf or intermediate in the served chain stops every writer until it is replaced; bodies
  already stored keep their own chain, and each device rejects one whose chain has expired. Publish or republish each
  live channel, and finish or replace rollouts, before an old leaf expires; `tide probe` fails on an expired served
  chain. An expired root stops every writer and every build that embeds it.

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
new store build ships. That build needs a new key under a new `keyid` and a new runtimeVersion, on the same bucket
and `updates.url` (One signing identity per runtime); in chain mode a lost leaf key needs only a new leaf under the
root (Chain mode). So schedule any deletion with the longest
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
before that decision and writes none. A `tide probe` whose `/manifest` request gets a 200 or 503 is a check like any
other, with no update IDs; `blob7` holds the side it was assigned.

| Field | Holds |
| --- | --- |
| `index1` | `expo-channel-name` |
| `blob1` | The reply served: `manifest`, `rollBackToEmbedded`, `noUpdateAvailable`, or `503` |
| `blob2` | `expo-platform`: `ios` or `android` |
| `blob3` | `expo-runtime-version` |
| `blob4` | `expo-current-update-id` |
| `blob5` | `expo-embedded-update-id` |
| `blob6` | `expo-recent-failed-update-ids`, comma-joined |
| `blob7` | The rollout side assigned: `new` or `earlier` (also when the new-update guard serves no-update, which `blob1` shows); `none` for a plain pointer, no pointer, or a 503 |
| `double1` | 1 when `expo-fatal-error` is present, else 0 |

Headers are client input, so each value is bounded before it is written. Channel and runtime already passed the
reply key grammar (at most 64 ASCII characters). An update ID is kept only when it is a UUID, lowercased, else empty;
a repeated header arrives joined and is dropped. The failed IDs are read as a list of quoted strings: members that
are quoted UUIDs are kept, lowercased and in order, up to 5 (a stock client sends at most 5); any other member is
dropped. `expo-fatal-error` holds the client's error message, which may contain user data, so only its presence is
recorded. The client ID is never recorded. A point is therefore at most 64 bytes of index and 352 bytes of blobs (an
earlier-side rollback on Android: 18 + 7 + 64 + 36 + 36 + 184 + 7), well inside Analytics Engine's limits (96-byte
index, 16 KB of blobs).

The sink is never awaited: a sink that throws, rejects, or returns a promise that never settles leaves the reply
unchanged, and a throw or rejection is logged by error name only, never with the point's values.

**Node.** The Node entry records nothing unless `TIDE_ANALYTICS` is `stdout`; unset or empty is off, and any other value
exits 1 at startup. Each point is then one line of JSON on stdout, the only lines that start with `{` (the entry's own are
`tide listening on port <port>` and `tide closing`; errors go to stderr):

```json
{"schema":1,"time":"<ISO ms Z>","indexes":["main"],"blobs":["manifest","ios","1.0.0","6e0c1b9a-3f7d-4a2e-8b5c-9d1e2f3a4b5c","6e0c1b9a-3f7d-4a2e-8b5c-9d1e2f3a4b5c","00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002","none"],"doubles":[1]}
```

`indexes[0]` is `index1`, `blobs[0]` to `blobs[6]` are `blob1` to `blob7` and `doubles[0]` is `double1`, exactly as in the
table; only `schema` and `time` are added, since Analytics Engine stamps its own time. `schema` changes by the rule under
JSON output. Nothing is sampled, but a line is never waited for: one that cannot be written (a closed reader, a full disk) is
lost, and while a stalled reader has filled Node's 64 KiB stdout buffer new points are dropped until it drains, so at most
that and one line is held. Lines still buffered at exit are lost, and the last one can be cut. Use a pipe or a file, as
container runtimes do: Node writes to a terminal synchronously, so one that stops reading stops the server.

### `tide probe`

A synthetic check that sees what an installed build would. It is read-only and needs no store credentials and no
signing key, so it can run from any monitor:

```
tide probe --server-url <url> --channel <name> --runtime-version <version> --platform ios|android [--app-id <id>]
  [--rollout-side new --rollout-update <updateId>] [--json]
```

`--server-url` is the base before `/manifest` (`https:`, or `http:` to a loopback IP literal). The pins are the
builds' own: `TIDE_BUILD_KEYID`, and the certificate the builds embed in exactly one of `TIDE_BUILD_CERTIFICATE_FILE`
(a path, at most 64 KiB) or `TIDE_BUILD_CERTIFICATE` (the PEM). The certificate must pass the same profile and
validity checks as at publish, so an expired one fails the probe. With `TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN=true` it is
the root, the reply must carry a `certificate_chain` part, and the signed part verifies under that chain's leaf after
`certificateChain` passes it over the root now, with the `keyid` ignored as the client ignores it; direct mode ignores
a `certificate_chain` part.

The probe sends `GET /manifest` as a stock client: `expo-protocol-version: 1`, `expo-expect-signature` with the
pinned keyid (so a version-3 `reply/no-update` answers with that keyid's entry), `accept: multipart/mixed`, and no current
update ID, so a pointer is served whenever one exists. It
parses the multipart reply and verifies the `expo-signature` of the one manifest or directive part over its exact
bytes. A directive (`rollBackToEmbedded`, or `noUpdateAvailable` from `reply/no-update`) passes on that alone. A
manifest's signed `runtimeVersion` must be the one requested, and no `expo-manifest-filters` member may differ
from the signed `metadata` key it names, since a client launches neither. Its `launchAsset.url` is then fetched
wherever it points and its SHA-256 compared with `launchAsset.hash`; other assets are not fetched. `/manifest` has 10 s and the launch asset 60 s, each covering the body.

**A rollout's new side.** `--rollout-side new --rollout-update <updateId>`, given together, sends an
`EAS-Client-ID` in bucket 0 of that update's rollout: the first of a fixed sequence that `rolloutBucket` puts there, so
the same one each run. Bucket 0 is on the new side at every percentage from 0.01, and on the earlier one at 0. The probe
has no bucket access, so the operator gives the ID, a lowercase UUID as `tide status` prints it. Exit 0 then means the
server served that client that update. Anything else it served, a directive or another update, is exit 9: a rollout
reverted or replaced, or no pointer (exit 4 when `reply/no-update` is missing too, as the server answers 503). A
complete rollout and a plain pointer to the update answer alike, so both pass; `tide status` tells them apart.

| Exit | Meaning |
| --- | --- |
| 0 | Passed; stdout names the directive, or the update ID and the launch asset hash checked |
| 2 | Usage or configuration; nothing was sent |
| 3 | Unreachable: a request failed or passed its deadline |
| 4 | `/manifest` or the launch asset answered a status other than 200 (404 for the asset is 7) |
| 5 | Unparseable reply: not `multipart/mixed`, no `expo-protocol-version: 1`, filters that are not a dictionary of strings, a bad body, no single signed part, or malformed JSON |
| 6 | Signature: missing, malformed, another keyid, or not verifying under the pinned certificate; in chain mode, no `certificate_chain` part, a chain that fails the client's rules, or no verify under the served leaf |
| 7 | The launch asset answered 404 |
| 8 | The launch asset's SHA-256 differs from the manifest's hash |
| 9 | The signed manifest is for another runtime version than `--runtime-version`, its metadata fails the reply's filters, or the reply is not the `--rollout-update` update |

`--json` names 3 to 9 `unreachable`, `status`, `unparseable`, `signature`, `bundleMissing`, `bundleHash` and `mismatch`.
Exit 1 is left to an uncaught error, so it always means a bug. Messages are fixed text naming the failure and at
most a status; no header value, key or response body is printed.

### `tide stats`

Reads those points back through Cloudflare's Analytics Engine SQL API, so it is Workers only: the Node server's checks
are not in Analytics Engine.

```
tide stats [--window <n>h|<n>d] [--channel <name>] [--runtime-version <version>] [--platform ios|android]
  [--update <updateId> --max-failed-share <percent> --min-checks <n>] [--print-sql] [--json]
```

| Variable | Holds |
| --- | --- |
| `TIDE_ANALYTICS_TOKEN` | A Cloudflare API token with the one permission Account Analytics Read |
| `TIDE_ANALYTICS_ACCOUNT_ID` | The account's 32 hex digit ID |
| `TIDE_ANALYTICS_DATASET` | The environment's dataset in its `wrangler.jsonc`, a plain SQL identifier; default `tide_manifest` |

It reads no other variable, no bucket and no key. Each query is one `POST` to
`https://api.cloudflare.com/client/v4/accounts/<account>/analytics_engine/sql`, which no flag or variable changes. A
redirect is not followed, so the token goes nowhere else. A query has 30 s, body included, and a reply at most 1 MiB; none is
retried. Messages are fixed text and at most a status: no token, header or reply is printed.

`--window` is whole hours or days: default 24h, at most 89d (2136h), since Analytics Engine keeps points three months
and the shortest three are 89 days. Every value is checked before it enters a query (the reply key grammar, a lowercase
UUID, whole numbers, the identifier), and none may hold a quote, backslash or space.

**Checks, not devices.** A check is one point: one `/manifest` request answered 200 or 503, probes included. A device
checks many times, and a point holds no client ID, so no count is a number of devices. The update IDs are what
clients sent, so anyone who can reach `/manifest` can add checks; read a verdict as a signal, not proof.

**Weights.** Analytics Engine samples under load, and each stored row's `_sample_interval` is the number of points it
stands for. Every count is `SUM(_sample_interval)`, never a number of rows, and is an estimate once points are sampled.

Checks per update the client runs; `-` is a check that sent none, as a probe:

```sql
SELECT blob4 AS update_id, SUM(_sample_interval) AS checks
FROM tide_manifest
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY update_id
ORDER BY checks DESC, update_id
LIMIT 1001
FORMAT JSON
```

Checks per update the client lists as failed. SQL here has no array functions, so `blob6` is grouped as stored, and the CLI
counts each list's checks once for every ID in it. A device that failed an update keeps listing it (a stock client lists at
most 5), so one failure is counted again at each later check, also after the device moved on:

```sql
SELECT blob6 AS failed_ids, SUM(_sample_interval) AS checks
FROM tide_manifest
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob6 != ''
GROUP BY failed_ids
ORDER BY checks DESC, failed_ids
LIMIT 1001
FORMAT JSON
```

Checks per rollout side; `-` is a point of a 0.1.0 Worker, which recorded none:

```sql
SELECT blob7 AS side, SUM(_sample_interval) AS checks
FROM tide_manifest
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY side
ORDER BY checks DESC, side
LIMIT 1001
FORMAT JSON
```

Each query asks for 1,001 groups and reports 1,000, most checks first. When there are more, the text says `truncated` and
`--json` sets it: updates with fewer checks are left out, and every count per failed ID is a lower bound.

**Verdict.** `--update`, `--max-failed-share` (a percentage from 0 to 100 in steps of 0.01) and `--min-checks` go together,
and one query replaces the reports. A check that lists the update as failed is in the first group and every other check
that runs it is in the second, so a check that does both counts once. For
`--update 00000000-0000-4000-8000-000000000001 --max-failed-share 5 --min-checks 500`:

```sql
SELECT if(position('00000000-0000-4000-8000-000000000001' IN blob6) > 0, 'failed', 'running') AS outcome, SUM(_sample_interval) AS checks
FROM tide_manifest
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND (blob4 = '00000000-0000-4000-8000-000000000001' OR position('00000000-0000-4000-8000-000000000001' IN blob6) > 0)
GROUP BY outcome
ORDER BY checks DESC, outcome
LIMIT 1001
FORMAT JSON
```

With fewer checks than `--min-checks` the result is not enough checks. Otherwise the update is bad when `failed` is over
the share of both groups; exactly at the share is ok.

`--print-sql` prints the queries the same arguments would send, separated by a blank line, for running elsewhere; it sends
nothing, needs no token or account ID, and does not go with `--json`.

| Exit | Meaning |
| --- | --- |
| 0 | Reported; with `--update`, the update is ok or there are not enough checks |
| 2 | Usage or configuration; nothing was sent |
| 3 | Unreachable: a request failed or passed its deadline |
| 4 | The SQL API answered a status other than 200: a redirect, a token it refuses, a rate limit, or an error of its own |
| 5 | Unparseable reply: over 1 MiB, not JSON, a missing column, a repeated group, or a value or count of another form |
| 10 | The update is bad; no other Tide failure exits with it |

Exit 1 is left to an uncaught error, so it always means a bug, and an outage never reads as a bad update.
