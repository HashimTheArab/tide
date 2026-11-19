---
status: draft
updated: 2026-11-19
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
lock                                     publish and gc lock
```

The server's credentials are read-only, with one exception: a Workers R2 binding cannot be made read-only, so the
Worker holds write access it never uses. Its store type admits only `get`, and only `src/workers.ts` touches the
binding. Code running inside the Worker could delete objects; it could not make a write pass the client's signature
and hash checks. An operator who needs a strictly read-only Worker can point the S3 adapter at R2's S3 API with a
read-only token.

- **Keys** are a known prefix plus a hash (`assets/<64 lowercase hex>`) or a reply key. Objects are stored
  unencoded; an object with a `content-encoding` other than `identity` is an error, not an asset.
- **Reply keys** come from protocol `replyKey`, shared by server and CLI. Channel and runtime version are each 1 to 64
  of `A-Z a-z 0-9 . _ + -`, and neither is `.` or `..`, so no header value can name another key; platform is `ios` or
  `android`. S3 receives each key segment percent-encoded (`+` as `%2B`). The `nativeVersion` runtime policy writes
  `1.0.0(1)`, outside the grammar, so it is unsupported: such a client gets a 400 and keeps its current update.
- **S3** (Node): path-style GetObject signed with SigV4. The credentials need `s3:GetObject` and `s3:ListBucket`;
  without ListBucket, S3 answers a missing key with 403, which the server must treat as an outage. Configured by
  `TIDE_S3_ENDPOINT`, `TIDE_S3_REGION`, `TIDE_S3_BUCKET`, `TIDE_S3_ACCESS_KEY_ID` and `TIDE_S3_SECRET_ACCESS_KEY`.
- **Disk** (Node, tests and single-host development): `TIDE_DISK_DIR`. The root is trusted: only the publisher
  writes it. Containment is the key grammar alone, checked before any filesystem call; there are no symlink,
  realpath or volume checks and no metadata files. A root missing after startup is an outage (503), not a miss.
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

`publish` (in CI):

1. Take `lock` with a conditional create.
2. Run `expo export`; hash every file (SHA-256, base64url); upload missing `assets/` and `bundles/`. Keep Metro's
   asset keys, which the bundle references, and refuse to publish a key already recorded for a different SHA-256 in
   any retained update or registered build.
3. Compose the manifest with `createdAt = max(now, previous pointer and any rollback commitTime + 1 ms)`; refuse if
   the clock differs from the bucket's `Date` by more than a minute.
4. Sign the exact part bytes (RSA PKCS#1 v1.5, SHA-256) through a KMS or a protected CI secret.
5. Build `BSDIFF40` patches from every registered base for the runtime and platform (embedded builds plus the last N
   updates); apply each and check its hash before upload; keep one only if it is well under the compressed bundle.
6. Write the release record, bases and patches, then the pointer with `If-Match` on its ETag; release `lock`.

Other commands: `register-build` (record a store build's embedded update ID and bundle as a base), `rollback`
(a signed `rollBackToEmbedded` with a fresh `commitTime`, or a republish of older code under a new ID), `republish`,
`status`, and `gc` (under `lock`, dry-run by default; never deletes anything a retained update, rollback, base or
legacy map references).

## Keys

A leaked key can ship code to every installed app. Publish only from CI and sign through a non-exportable KMS key
where possible. Apps should embed a root certificate and request a certificate chain, so the signing key can rotate
without an app release.

## Observability

One analytics data point per `/manifest` (runtime, platform, current and embedded IDs, recent failed update IDs,
fatal-error flag), and a synthetic probe that verifies a manifest's signature against a pinned certificate and
fetches its bundle.

## Later

- Staged rollouts: a percentage in the pointer, a hash of `EAS-Client-ID`, two pre-signed bodies.
- Hermes delta compiles (`hermesc -base-bytecode`), measured against plain bsdiff.
