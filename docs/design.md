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
updates/<updateId>.json                  release record: launch hash, asset hashes, createdAt
reply/<channel>/<runtime>/<platform>     stored reply: a signed manifest or rollBackToEmbedded (the pointer)
reply/no-update                          stored reply: the signed noUpdateAvailable
bases/<updateId>                         launch hash of each patch base (OTA update or embedded build)
patches/<fromHash>/<toHash>              BSDIFF40 patch
gc/candidates.json                       objects the last gc scan found unreferenced, with the scan time
```

The server's credentials are read-only, with one exception: a Workers R2 binding cannot be made read-only, so the
Worker holds write access it never uses. Its store type admits only `get`, and only `src/workers.ts` touches the
binding. Code running inside the Worker could delete objects; it could not make a write pass the client's signature
and hash checks. An operator who needs a strictly read-only Worker can point the S3 adapter at R2's S3 API with a
read-only token.

- **Keys** are a known prefix plus a hash (`assets/<64 lowercase hex>`) or a reply key. Objects are stored
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
  writes it. Containment is the key grammar alone, checked before any filesystem call; there are no symlink,
  realpath or volume checks and no metadata files except `.tide/`, which holds the CLI's writer mutex and staged
  files and which no key can name. A root missing after startup is an outage (503), not a miss.
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
- Otherwise: 200, the full bundle, `public, max-age=31536000, immutable`.
- Patches are never shared-cached: a cached patch under the plain URL would break the client's full-file retry.

### Other routes

- Non-launch assets are served from the bucket's public domain with a one-year immutable cache.
- `GET /assets?h=<hash>&ext=<ext>` streams `assets/<hex>`, for URLs published by earlier servers. `h` must be one
  canonical unpadded base64url SHA-256 (43 characters, zero trailing bits: protocol `assetHash`), else 400. The
  `content-type` comes from `ext`, a bare extension, through protocol `assetContentType`, the table the publisher
  also uses; no or an unknown `ext` gives `application/octet-stream`. A 200 is `public, max-age=31536000,
  immutable`; every other reply is `no-store` (404 when absent, 503 when the store fails). Earlier servers also
  served launch bundles this way, so the legacy import stores every object a legacy `?h=` URL names under
  `assets/`, launch bundles included, and records each key in the legacy map `gc` honours. These URLs get no
  patches. A frozen map can cover other legacy URL shapes.
- `GET /hc`.

## CLI

**One writer at a time.** `publish`, `rollback`, `republish`, `register-build` and `gc` run only from one CI
workflow whose concurrency group (for example `concurrency: tide-publish`) runs them one at a time. There is no lock
object: a lease lock in a bucket cannot stop a delayed write from landing after another writer takes over. As a
backstop, the pointer write is conditional, so an accidental second writer fails cleanly instead of overwriting.

### Bucket configuration

The CLI reads the same variables as the Node server: `TIDE_DISK_DIR`, or all five `TIDE_S3_*` (exactly one store;
empty counts as unset). A configuration error exits before any request.

- **Write credentials.** The CLI's S3 key needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and
  `s3:ListBucket`; on R2, an Object Read & Write token scoped to the bucket. Keep it a protected CI secret; the server
  keeps its read-only key. The secret is only used to derive signatures: it is never sent, put in a URL or printed.
- **Writes.** Every request is signed (SigV4, with the payload hash). A pointer write is `PutObject` with
  `If-Match: <etag>`, or `If-None-Match: *` for a first publish; a 412 is a lost race, and every other answer is an
  error. ETags are opaque strings, compared exactly. A write that got no answer, a 5xx, or a 200 without a valid ETag
  has an unknown outcome: the writer stops, exits non-zero, and the next run starts from what the bucket holds,
  since S3 and R2 may still commit it. A later `gc` must prove that no delete can remove an object that a committed
  or still-pending pointer write references.
- **Disk.** Writers on one host serialise on a SQLite lock in `.tide/mutex.sqlite` (an `fcntl` lock the OS frees
  when its holder dies). Each conditional write reads, compares and renames a staged file inside it. Readers take no
  lock. Network filesystems are not supported.
- **Clock.** The bucket's time is S3's `Date` header, or the local clock on disk.

`tide status` prints one line per pointer (`<channel> <runtime> <platform> <kind> <updateId|-> <createdAt|commitTime>`,
read from the stored signed part without re-serialising it) and whether `reply/no-update` is present, unreadable or
missing. It exits 1 if any record is unreadable, and 2 on a configuration or listing error. An unreadable record is
reported by its key, the same name a readable row prints, with a fixed reason; a name outside the key grammar and a
stored field are never printed.

`publish`:

1. Run `expo export`; hash every file (SHA-256, base64url); upload missing `assets/` and `bundles/`. Keep Metro's
   asset keys, which the bundle references, and refuse to publish a key already recorded for a different SHA-256 in
   any retained update or registered build.
2. Compose the manifest with `createdAt = max(now, previous pointer and any rollback commitTime + 1 ms)`; refuse if
   the clock differs from the bucket's `Date` by more than a minute.
3. Sign the exact part bytes (RSA PKCS#1 v1.5, SHA-256) through the configured key source (Keys).
4. Build `BSDIFF40` patches from every registered base for the runtime and platform (embedded builds plus the last N
   updates); apply each and check its hash before upload; keep one only if it is well under the compressed bundle.
5. Write the release record, bases and patches, then the pointer with `If-Match` on its ETag.

Other commands: `register-build` (record a store build's embedded update ID and bundle as a base), `rollback`
(a signed `rollBackToEmbedded` with a fresh `commitTime`, or a republish of older code under a new ID), `republish`,
`status`, and `gc` (dry-run by default; never deletes anything a retained update, rollback, base or legacy map
references). `gc` is two-pass mark and sweep: each run records the unreferenced objects it finds in
`gc/candidates.json`, and deletes only objects that were already candidates in a scan at least 24 hours earlier and
are still unreferenced. A publish that reuses an object in between makes it referenced again, so it survives.

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
reads `reply/no-update`. Each refusal has a fixed message that names variables and config fields, never a key,
credential or provider text.

**One signing identity per bucket.** Every build a bucket serves gets the same signed `reply/no-update`. When it
exists, the CLI requires its directive to be a signed `noUpdateAvailable` that verifies under the configured
certificate and `keyid`. A new key or key ID therefore needs a new bucket and `updates.url`. `publish` creates
`reply/no-update` with put-if-absent before any pointer and re-checks a winner it did not write; it re-checks the
certificate's validity before the pointer write; and it runs `expo config` and `expo export` with every `TIDE_`
variable removed and `EXPO_NO_DOTENV=1`, so no signing or storage secret reaches project code.

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
