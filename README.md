# Tide

**A serverless Expo Updates server for Cloudflare Workers or any container.**

Tide sends over-the-air updates to React Native apps that use Expo's own
[`expo-updates`](https://docs.expo.dev/versions/latest/sdk/updates/) library. You publish from your machine or CI;
Tide stores each update in one bucket and serves it to your apps. There is no database to run, no SDK to swap in, and
no signing key on the server.

> Status: pre-release. Nothing is on npm yet, so Tide runs from a checkout of this repository. See [Status](#status).

## How it works

```text
  Your machine or CI                        Bucket (R2 or S3)               Tide server
  ┌───────────────────────────┐             ┌───────────────────┐           ┌──────────────────────┐
  │ tide export: builds the   │             │ signed updates    │   reads   │ Cloudflare Workers   │
  │ app, holds no secrets     │             │ patches           │ ◄──────── │ or a container       │
  │            │              │   uploads   │ assets            │           │ holds no key         │
  │            ▼              │ ──────────► │                   │           └──────────┬───────────┘
  │ tide publish: signs and   │             └───────────────────┘                      │ updates
  │ uploads, runs no app code │                                                        ▼
  └───────────────────────────┘                                          Apps check the signature first
```

- **Updates are signed when you publish, never by the server.** The server holds no key. Someone who takes over the
  server can stop or replay updates, but cannot make your apps run new code.
- **Signing is required.** Apps ship with a certificate, and Tide never publishes an unsigned update.
- **One bucket, no database.** Everything Tide needs is in the bucket, so the same server runs on Cloudflare Workers
  or as a container on any host.
- **Small downloads.** At publish time Tide builds patches, so an app downloads only what changed. This works from
  earlier updates and from the bundle inside the store build, so even a fresh install's first update can be small.
- **Building and signing stay apart.** Only `tide export` runs your app's code, and it has no secrets. The step that
  signs and uploads runs none of your code.

## Compared with other servers

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
2. xprem needs PostgreSQL for bundle diffing and rollouts. Its stateless mode drops PostgreSQL but reads channels from
   Expo's API and has neither feature.
3. Planned; see "Later" in [docs/design.md](docs/design.md#later).

Sources, checked on 2026-11-22:

- **EAS Update**: `docs/pages/eas-update/` in
  [expo/expo@aa82194](https://github.com/expo/expo/tree/aa82194f82a84173211b2b832b9249b0cfd2b1ef/docs/pages/eas-update):
  `introduction.mdx`, `code-signing.mdx`, `bundle-diffing.mdx` and `rollouts.mdx`.
- **xprem** (formerly expo-open-ota):
  [mercuretechnologies/xprem v3.2.7](https://github.com/mercuretechnologies/xprem/tree/v3.2.7) `README.md`, and its
  documentation for v3.2.0: [Keys](https://mercure-technologies.gitbook.io/xprem/key-store/keys),
  [Stateless mode](https://mercure-technologies.gitbook.io/xprem/stateless-mode/overview) and
  [Bundle diffing](https://mercure-technologies.gitbook.io/xprem/features/bundle-diffing-bsdiff).
- **Xavia OTA**: [xavia-io/xavia-ota@4558c9c](https://github.com/xavia-io/xavia-ota/tree/4558c9c61007940673ff90a505b0822a8dc45f3e) `README.md`,
  `docs/supportedStorageAlternatives.md` and `pages/api/manifest.ts` (the server signs each manifest with its key).
- **Hot Updater**: [gronxb/hot-updater v1.1.0](https://github.com/gronxb/hot-updater/tree/v1.1.0) `README.md` and
  `docs/content/docs/(latest)/`: `guides/bundle-signing.mdx`, `guides/bundle-diffing.mdx`,
  `guides/rollout-cohorts.mdx`, `guides/console.mdx` and `storage-adapters/cloudflare.mdx`.

## Quick start

You need the Node and pnpm versions listed under `engines` in [package.json](package.json).

```sh
pnpm install
alias tide="node $PWD/packages/cli/src/main.ts"   # the CLI, run from source
```

### On Cloudflare Workers

[`examples/operator/`](examples/operator/) is a ready project with a `staging` and a `production` environment, each
with its own R2 bucket. Set the Worker names, bucket names and `TIDE_APP_ID` in its `wrangler.jsonc`, then:

```sh
cd examples/operator
pnpm run wrangler r2 bucket create <bucket>
pnpm run wrangler deploy --env staging
```

Always pass `--env`. Before you publish, give the Worker and the bucket each a domain you own: those addresses end up
inside updates on users' phones, so they must keep working. [docs/deploy.md](docs/deploy.md) has the full setup.

### In a container

```sh
docker build -f packages/server/Dockerfile -t tide .
docker run --read-only -p 8787:8787 -v /srv/tide-bucket:/bucket:ro -e TIDE_DISK_DIR=/bucket tide
```

This serves a folder. To serve an S3-compatible bucket instead, set the `TIDE_S3_*` variables with read-only keys.
The container does not serve images and fonts, so give the bucket's assets a public address too, and set
`TIDE_SERVER_URL` and `TIDE_ASSET_URL` for publishing before the first publish.
[docs/deploy.md](docs/deploy.md#the-container) lists every variable.

### In your app

Point the app at your server and give it the certificate (step 5 of
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

## Publishing

Publishing is two steps, usually two CI jobs:

```sh
tide export --project-root <app> --out <dir>      # builds the app; needs no secrets
tide publish --from <dir> --channel main          # signs and uploads; runs no app code
```

The signing key can come from a file, an environment variable or AWS KMS. Run one publish at a time, and know that
Tide never deletes anything from the bucket. [docs/deploy.md](docs/deploy.md#publishing) shows a CI setup, and
[docs/design.md](docs/design.md#keys) covers keys.

## Bundle diffing

Turn on `updates.enableBsdiffPatchSupport` in the app, and it asks for a patch instead of the whole bundle. Tide
makes patches when you publish and keeps one only if it is correct and at most half the size of the bundle; otherwise
the app gets the whole bundle. Earlier updates count automatically. To also patch from the bundle inside a store
build, register that build once:

```sh
tide register-build --platform android --runtime-version 1.0.0 \
  --manifest app.manifest --bundle index.android.bundle --assets-dir <dir>
```

[docs/design.md](docs/design.md#patches) says which files to take from an APK or an `.app`.

## Operations

| Command | What it does |
| --- | --- |
| `tide status` | Lists what each channel serves right now |
| `tide storage` | Lists files nothing uses any more; deletes nothing |
| `tide probe --server-url <url> --channel <name> --runtime-version <version> --platform ios\|android` | Checks a live server the way an installed app would |
| `tide rollback --embedded --channel <name> --runtime-version <version>` | Sends apps back to the bundle inside the build |
| `tide rollback --to <updateId>` | Serves an earlier update again |
| `tide republish <updateId>...` | Serves stored updates again, optionally on another `--channel` or `--runtime-version` |

`tide probe` needs no secrets, only the build's public certificate: `TIDE_BUILD_KEYID` and one of
`TIDE_BUILD_CERTIFICATE_FILE` or `TIDE_BUILD_CERTIFICATE` ([setup](docs/design.md#tide-probe)). On Workers, every
update check also records one Analytics Engine data point. [docs/design.md](docs/design.md#cli) has every rule.

## Status

Pre-release. The server, CLI, bundle diffing, operations commands and container image are built and tested. Real
`expo-updates` apps on an Android emulator check updates, patches and rollbacks against a local Tide
(`pnpm conformance`). npm releases come later; [docs/roadmap.md](docs/roadmap.md) has every phase.

## Development

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules.

```sh
pnpm install
pnpm gate        # every check CI runs
```

## License

[MIT](LICENSE)
