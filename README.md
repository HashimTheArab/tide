# Tide

**A serverless Expo Updates server for Cloudflare Workers or any container.**

[![CI](https://github.com/HashimTheArab/tide/actions/workflows/ci.yml/badge.svg)](https://github.com/HashimTheArab/tide/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Tide sends over-the-air (OTA) updates to React Native apps that use Expo's own
[`expo-updates`](https://docs.expo.dev/versions/latest/sdk/updates/) library. There is no custom client SDK to adopt,
no database to run, and no signing key on the server. You publish from your machine or CI; Tide stores each signed
update in a single bucket and serves it from Cloudflare Workers or from a container on any host.

## Why Tide

- **Signed at publish time, never by the server.** Only the CLI signs, so the server holds no key. Whoever takes
  over the server can stop or replay updates, but cannot make your apps run new code.
- **Code signing is required, not optional.** Apps ship with a certificate and the CLI never publishes an unsigned
  update, so every update a device accepts has been verified against that certificate first.
- **Stock client, no migration.** Tide speaks Expo Updates protocol v1. Your app keeps using `expo-updates` exactly
  as Expo ships it; there is no SDK to swap in and no Expo account to depend on.
- **One bucket, no database.** Everything the server needs is in one R2 or S3-compatible bucket. That is the whole
  state, which is why the same server runs on Workers or in a container.
- **Small downloads.** At publish time Tide builds bsdiff patches from earlier updates and from the bundle inside
  the store build, so even a fresh install's first update can download only what changed.
- **Building and signing stay apart.** Only the build step runs your app's code, and it holds no secrets. The step
  that signs and uploads runs none of your code.
- **Two runtime dependencies.** The server uses [Hono](https://hono.dev) and its Node adapter; the CLI and the
  protocol package use none. Patching, compression, S3 signing and the AWS KMS client are built in.

## How it works

```text
  tide export            tide publish              Bucket (R2 / S3)           Tide server
  builds your app,  ──►  signs and uploads  ──►    signed updates,    ◄───    Workers or container,
  holds no secrets       runs no app code          patches, assets           reads only, holds no key
                                                                                    │
                                                                                    │ Expo Updates protocol v1
                                                                                    ▼
                                                                      Your app (stock expo-updates)
                                                                      verifies the signature, then applies
```

1. **Publish.** The CLI composes each update, signs the exact bytes it will serve, and uploads them to the bucket.
   The pointer each channel serves is then swapped with a conditional write, so a reader sees the old reply or the
   new one, never a mix.
2. **Serve.** The server chooses a stored reply from the request's channel, runtime version and platform, and
   streams those exact signed bytes back. It never re-serialises what was signed, and it only ever reads.
3. **Verify.** The stock client checks the manifest signature and every asset hash before anything runs. Bytes
   that fail those checks never execute, whoever served them.

The design behind all of this — storage layout, wire rules, key handling — is in [docs/design.md](docs/design.md).

## How Tide compares

| | Tide | EAS Update | xprem | Xavia OTA | Hot Updater |
| --- | :---: | :---: | :---: | :---: | :---: |
| Self-hosted | ✅ | ❌ | ✅ | ✅ | ✅ |
| Works with stock `expo-updates` (no SDK swap) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Server holds no signing key | ✅ | ✅¹ | ❌ | ❌ | ✅ |
| Signing key can stay in AWS KMS | ✅ | ❌ | ❌ | ❌ | ✅ |
| Runs on Cloudflare Workers | ✅ | ❌ | ❌ | ❌ | ✅ |
| No database or Expo account needed | ✅ | ❌ | ❌² | ❌ | ❌ |
| Bundle diffing (download only what changed) | ✅ | ✅ | ✅² | ❌ | ✅ |
| Diffing from the bundle inside the store build | ✅ | ✅ | ❌ | ❌ | ❌ |
| Web dashboard | ❌ | ✅ | ✅ | ✅ | ✅ |
| Staged rollouts | ❌³ | ✅ | ✅² | ❌ | ✅ |

❌ also means the project's own docs do not mention the feature.

1. Only on Expo's Production and Enterprise plans, where `eas update` signs locally.
2. xprem needs PostgreSQL for bundle diffing and rollouts. Its stateless mode drops PostgreSQL but reads channels
   from Expo's API and has neither feature.
3. Planned; see "Later" in [docs/design.md](docs/design.md#later).

Sources for every cell: [docs/comparison.md](docs/comparison.md).

## Quick start

Tide's packages need Node 24.11 or later.

### Run the server on Cloudflare Workers

In your Worker project:

```sh
npm install @tide-ota/server
npm install --save-dev wrangler
```

Copy `worker.ts` and `wrangler.jsonc` from [`examples/operator/`](examples/operator/): a one-line Worker with a
`staging` and a `production` environment, each with its own R2 bucket. Set the Worker names, bucket names and
`TIDE_APP_ID` in `wrangler.jsonc`, then:

```sh
npx wrangler r2 bucket create <bucket>
npx wrangler deploy --env staging
```

Always pass `--env`. Before the first publish, give the Worker and the bucket each a domain you own: those
addresses end up inside signed updates on users' phones, so they must keep working for as long as those builds are
installed. [docs/deploy.md](docs/deploy.md) walks through the full setup, accounts and tokens included.

### Or run it in a container

In the container's project:

```sh
npm install @tide-ota/server
TIDE_DISK_DIR=/srv/tide-bucket node node_modules/@tide-ota/server/dist/node.js
```

This serves a local folder on port 8787. To serve an S3-compatible bucket instead, set the `TIDE_S3_*` variables
with read-only credentials. The Node server does not serve images and fonts, so give the bucket's assets a public
address of their own, and set `TIDE_SERVER_URL` and `TIDE_ASSET_URL` before the first publish.
[docs/deploy.md](docs/deploy.md#the-container) lists every variable and has a reference image.

### Point your app at it

Give the app your server's address and the signing certificate (step 5 of
[Setting up an environment](docs/deploy.md#setting-up-an-environment) creates it):

```js
{
  runtimeVersion: "1.0.0",
  updates: {
    url: "https://updates.example.com/manifest",
    requestHeaders: { "expo-channel-name": "main" },
    codeSigningCertificate: "./keys/certificate.pem",
    codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
  },
}
```

The channel header is required, and the runtime version must resolve to one you have published; a runtime with
nothing published answers with a signed "no update available" rather than an error.

## Publishing

Install the CLI where you publish, with `npm install --save-dev @tide-ota/cli`, and run it as `npx tide`.
Publishing is two steps, designed to run as two separate CI jobs:

```sh
npx tide export --project-root <app> --out <dir>    # builds the app; needs no secrets
npx tide publish --from <dir> --channel main        # signs and uploads; runs no app code
```

The signing key can come from a file, an environment variable, or AWS KMS — through KMS the private key never
leaves AWS. Run one publish at a time (a single CI concurrency group), and know that Tide never deletes anything
from the bucket: published URLs must keep working for every device that holds them.
[docs/deploy.md](docs/deploy.md#publishing) shows a complete CI setup, and [docs/design.md](docs/design.md#keys)
covers how keys and certificates are checked.

## Bundle diffing

Turn on `updates.enableBsdiffPatchSupport` in the app, and it will ask for a patch instead of the whole bundle.
Tide builds patches when you publish, applies each one back and checks the result's hash before uploading, and
keeps a patch only when it is at most half the bundle's compressed size; otherwise the app simply gets the whole
bundle. Patches from earlier updates need no setup. To also patch from the bundle inside a store build — so a
fresh install's first update is small too — register that build once:

```sh
tide register-build --platform android --runtime-version 1.0.0 \
  --manifest app.manifest --bundle index.android.bundle --assets-dir <dir>
```

[docs/design.md](docs/design.md#patches) explains which files to take from an APK or an `.app`.

## Operations

| Command | What it does |
| --- | --- |
| `tide status` | Lists what each channel serves right now |
| `tide storage` | Lists files nothing references any more; deletes nothing |
| `tide probe --server-url <url> --channel <name> --runtime-version <version> --platform ios\|android` | Checks a live server the way an installed app would |
| `tide rollback --embedded --channel <name> --runtime-version <version>` | Sends apps back to the bundle inside the store build |
| `tide rollback --to <updateId>` | Serves an earlier update again |
| `tide republish <updateId>... [--channel <name>] [--runtime-version <version>]` | Serves stored updates again, optionally on another channel or runtime |

`tide probe` needs no secrets and no bucket access. It identifies builds by `TIDE_BUILD_KEYID` and the certificate
they embed, given as exactly one of `TIDE_BUILD_CERTIFICATE_FILE` or `TIDE_BUILD_CERTIFICATE`, then checks a live
server end to end: it verifies the reply's signature under that certificate and compares the served bundle's hash
with the signed manifest. On Workers, every update check that reaches a reply also records one Analytics Engine
data point; the container records nothing. [docs/design.md](docs/design.md#cli) documents every command's rules
and exit codes.

## Security model

- **The server only reads.** It holds no signing key and no write credentials. On Workers the R2 binding cannot
  be made read-only, so the Worker holds write access it never uses — its storage type admits only reads.
- **The bucket is trusted by design, and devices are the backstop.** Only the CLI writes to the bucket, after
  validating and signing. Even so, a stock client verifies every signature and asset hash, so bytes that were not
  signed by your key never run.
- **The key lives in CI, ideally in KMS.** A leaked signing key can ship code to every installed app, so publish
  only from CI and prefer AWS KMS, where the key cannot be exported. One signing identity serves one bucket; a
  new key means a new bucket and a new updates URL.
- **Report problems privately.** See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## What's in this repository

| Path | What it holds |
| --- | --- |
| `packages/server` | The Hono server: runtime-free core, plus Workers and Node entry points |
| `packages/protocol` | The shared manifest, multipart, signature and patch contract |
| `packages/cli` | The CLI: export, publish, register builds, roll back, inspect and probe |
| `conformance/` | Stock `expo-updates` release apps checked against a local Tide |
| `examples/operator/` | The minimal operator Worker described in the quick start |
| `docs/` | Design, deploy guide, roadmap and decision records |

## Status

Early (0.x). The server, the CLI, bundle diffing, the operations commands and the container image are built and
covered by tests on both Workers and Node. Real `expo-updates` apps check updates, patches and rollbacks against a
local Tide (`pnpm conformance`, run separately from the gate): nightly on an Android emulator, and on an iOS simulator
before each release. Releases are published to npm from CI ([docs/release.md](docs/release.md));
[docs/roadmap.md](docs/roadmap.md) lists every phase.

## Development

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules and the reasoning behind them. A checkout needs the Node and pnpm
versions under `engines` in [package.json](package.json), and runs everything from source:

```sh
pnpm install
pnpm gate                                         # every check CI runs
alias tide="node $PWD/packages/cli/src/main.ts"   # the CLI, run from source
```

Documentation starts at [docs/README.md](docs/README.md): the [design](docs/design.md) for how Tide works and
the [deploy guide](docs/deploy.md) for running it.

## License

[MIT](LICENSE)
