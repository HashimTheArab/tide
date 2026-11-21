# Tide

**A serverless Expo Updates server for Cloudflare Workers or any container.**

Tide serves over-the-air updates to React Native apps that use the stock
[`expo-updates`](https://docs.expo.dev/versions/latest/sdk/updates/) library, over the Expo Updates protocol v1. A
CLI builds, signs and uploads every reply to one bucket (R2 or S3-compatible); the server picks a stored reply from
the request headers and streams it. The same server runs on Cloudflare Workers or in a Node container.

> Status: pre-release. Nothing is on npm yet, and it is not ready for production use. See [Status](#status).

## Why Tide

- **The server signs nothing.** Manifests are signed once, at publish time, by the CLI. The server holds no key, so
  a compromised server can withhold or replay updates but cannot make an app accept new code.
- **Code signing is required.** Apps must ship a code-signing certificate, and the CLI never publishes unsigned. An
  app without a certificate would run whatever the bucket holds, so Tide does not support one.
- **No database.** One bucket holds every update, reply and patch. Publishing makes one conditional pointer write
  per platform.
- **Bundle diffing, including from the embedded bundle.** The CLI builds bsdiff patches at publish time, from earlier
  updates and from the bundle inside a store build, so a fresh install's first update can be a patch too.
- **Read-only server.** The server has no dashboard, no publish API and read-only storage credentials. The one
  exception is the Workers R2 binding, which cannot be made read-only; the Worker only reads through it.

[docs/design.md](docs/design.md) explains how it works and [docs/decisions/](docs/decisions/0001-architecture.md)
why.

## Quick start

Until the packages are on npm, Tide runs from a checkout of this repository. You need the Node and pnpm versions in
`engines` in [package.json](package.json).

```sh
pnpm install
alias tide="node $PWD/packages/cli/src/main.ts"   # the CLI, run from source
```

### Cloudflare Workers

[`examples/operator/`](examples/operator/) is a complete operator project: a one-line `worker.ts` and a
`wrangler.jsonc` with a `staging` and a `production` environment, each binding its own R2 bucket. In your fork, set
the Worker names, bucket names and `TIDE_APP_ID` in its `wrangler.jsonc`, then:

```sh
cd examples/operator
pnpm run wrangler r2 bucket create <bucket>
pnpm run wrangler deploy --env staging
```

Every deploy needs `--env`; without it the Worker has no bindings. Attach a domain you control to the Worker and
another to the bucket's public access before the first publish: both are inside signed manifests on devices, so they
must keep working. [docs/deploy.md](docs/deploy.md) covers accounts, tokens, domains and routine deploys.

### Container

Build the Node image from the repository root and point it at a bucket directory or an S3-compatible bucket:

```sh
docker build -f packages/server/Dockerfile -t tide .
docker run --read-only -p 8787:8787 -v /srv/tide-bucket:/bucket:ro -e TIDE_DISK_DIR=/bucket tide
```

For S3, set the five `TIDE_S3_*` variables, with read-only credentials, instead of `TIDE_DISK_DIR`. `GET /hc` is the
health check. [docs/deploy.md](docs/deploy.md#the-container) lists every variable.

The container serves manifests and launch bundles, not images or fonts, so set up an asset origin and the
publisher's `TIDE_SERVER_URL` and `TIDE_ASSET_URL` before the first publish
([docs/deploy.md](docs/deploy.md#the-container)).

### The app

A build finds its updates by URL, channel and runtime version, and trusts them by certificate
([docs/deploy.md](docs/deploy.md#the-app); step 5 of
[Setting up an environment](docs/deploy.md#setting-up-an-environment) generates the certificate). The app config:

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

## Publishing and signing

Publishing is two steps, meant to run as two CI jobs:

```sh
tide export --project-root <app> --out <dir>      # runs Expo; reads no credential
tide publish --from <dir> --channel main          # signs and uploads; runs no project code
```

- **`tide export`** is the only command that runs project code (the app config, Babel and Metro). It holds no
  secret, and Expo's tools get only an allowlisted environment. Its output directory is public data: the bundle,
  assets, public config and certificate.
- **`tide publish --from`** checks the export, signs one manifest per platform with a key from a file, the
  environment or AWS KMS, verifies every signature against the build certificate, uploads what is missing and writes
  each pointer with a conditional write.

Writers run one at a time, in one CI concurrency group. Nothing is ever deleted from the bucket. The workflow,
runner and credential setup is in [docs/deploy.md](docs/deploy.md#publishing), and key handling, including KMS
provisioning, in [docs/design.md](docs/design.md#keys).

## Bundle diffing

Clients with bsdiff enabled (`updates.enableBsdiffPatchSupport`) ask for a patch from the update they run. At
publish time the CLI builds a `BSDIFF40` patch to the new bundle from each registered base, applies it, and keeps it
only if the result hashes to the new bundle and the patch is at most half the bundle's gzip size. The server serves a
stored patch when one exists, and the full bundle otherwise.

Earlier updates become bases on their own. To patch from the bundle inside a store build, register that build once:

```sh
tide register-build --platform android --runtime-version 1.0.0 \
  --manifest app.manifest --bundle index.android.bundle --assets-dir <dir>
```

[docs/design.md](docs/design.md#patches) has the patch format and which files to take from an APK or an `.app`.

## Operations

| Command | What it does |
| --- | --- |
| `tide status` | One line per pointer: channel, runtime, platform, kind, update ID and time |
| `tide storage` | Read-only report of objects nothing references; deletes nothing |
| `tide probe --server-url <url> --channel <name> --runtime-version <version> --platform ios\|android` | Fetches the manifest as an installed build would, verifies its signature and the launch bundle's hash |
| `tide rollback --embedded --channel <name> --runtime-version <version>` | Serves a signed rollback to the bundle inside the build |
| `tide rollback --to <updateId>` | Serves an earlier update again, as a new and newer publish |
| `tide republish <updateId>...` | Serves stored updates again, optionally to another `--channel` or `--runtime-version` |

`tide probe` needs no store credentials or signing key, only the builds' public pins: `TIDE_BUILD_KEYID` and one of
`TIDE_BUILD_CERTIFICATE_FILE` or `TIDE_BUILD_CERTIFICATE` ([setup](docs/design.md#tide-probe)). The other commands
read the bucket, and `rollback` and `republish` also sign. On Workers, every manifest request also writes one Workers Analytics Engine data point. Exit codes and every rule
are in [docs/design.md](docs/design.md#cli).

## Compared with other servers

Checked on 2026-11-21 against each project's own repository or documentation, at the versions in the sources list.
? means the source does not say; — is for a hosted service.

| | Tide | EAS Update | xprem | custom-expo-updates-server | self-hosted-expo-updates-server | cloudflare-expo-updates-server | hot-updater | react-native-update |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Client | Stock `expo-updates` | Stock `expo-updates` | Stock `expo-updates` | Stock `expo-updates` | Stock `expo-updates` | Stock `expo-updates` | Own SDK | Own SDK |
| Runs on Cloudflare Workers | ✅ | — | ? | ? | ? | ✅ | ✅ | ? |
| Runs as a container | ✅ | — | ✅ | ? | ✅ | ? | ✅ | ? |
| Where updates are signed | CLI, at publish | EAS CLI, at publish | Server, on each request | Server, on each request | Server, on each request | Not supported | CLI, at deploy (optional) | ? |
| Runs without a database | ✅ | — | ✅ stateless mode | ✅ | ❌ MongoDB | ✅ | ❌ | ? |
| Bundle diffing | ✅ | ✅ | ✅ needs PostgreSQL | ? | ✅ | ? | ✅ | ✅ |
| Patch from the embedded bundle | ✅ | ✅ | ? | ? | ? | ? | ❌ | ✅ |
| Roll back to the embedded bundle | ✅ | ✅ | ✅ | ✅ | ? | ? | ✅ | ✅ SDK call (`resetToPackagedBundle`) |
| Staged rollouts | ❌ | ✅ | ✅ needs PostgreSQL | ? | ? | ? | ✅ | ✅ |
| Dashboard | ❌ | ✅ | ✅ | ❌ | ✅ | ? | ✅ | ✅ |

A server that signs on each request holds the key, so whoever controls it can sign any code; a server that serves
manifests signed earlier cannot. "Not supported" means the project's README lists code signing as something to add.

Sources, all checked on 2026-11-21:

- **Tide**: [docs/design.md](docs/design.md) and the code on `main`.
- **EAS Update** (called Expo Update in its docs): `docs/pages/eas-update/` in
  [expo/expo@aa82194](https://github.com/expo/expo/tree/aa82194f82a84173211b2b832b9249b0cfd2b1ef/docs/pages/eas-update):
  `introduction.mdx`, `code-signing.mdx` (signed locally by `eas update`; Production or Enterprise plans),
  `bundle-diffing.mdx`, `rollbacks.mdx`, `rollouts.mdx` and `trace-update-id-expo-dashboard.mdx`.
- **xprem** (formerly expo-open-ota):
  [mercuretechnologies/xprem v3.2.7](https://github.com/mercuretechnologies/xprem/tree/v3.2.7) `README.md`, and its
  documentation for v3.2.0 (the latest it lists): Bundle Diffing (control plane only; patches from the 5 previous
  updates), Stateless mode, Rollback and Progressive rollouts.
- **custom-expo-updates-server**:
  [expo/custom-expo-updates-server@feb29fc](https://github.com/expo/custom-expo-updates-server/tree/feb29fc4ac1f5eb011bdfe95391190a91da4bb31),
  a demonstration its README says is not meant as a full backend: `README.md`,
  `expo-updates-server/pages/api/manifest.ts` and `expo-updates-server/common/helpers.ts`.
- **self-hosted-expo-updates-server**:
  [umbertoghio/self-hosted-expo-updates-server@64bd4e3](https://github.com/umbertoghio/self-hosted-expo-updates-server/tree/64bd4e3a71f42ebbc01df208dcdb0675ac186c53)
  `README.md`, `docs/bsdiff-binary-patches.md` (bases are uploaded updates) and
  `API/src/modules/expo/manifest.ts`.
- **cloudflare-expo-updates-server**:
  [isaiahbjork/cloudflare-expo-updates-server@aa7a768](https://github.com/isaiahbjork/cloudflare-expo-updates-server/tree/aa7a7686d8b2fbbb0b75a652c173c2d712d7597e)
  `README.md` (Security lists code signing as a recommendation) and `src/index.js`.
- **hot-updater**: [gronxb/hot-updater v1.1.0](https://github.com/gronxb/hot-updater/tree/v1.1.0) `README.md` and
  `docs/content/docs/(latest)/`: `guides/bundle-signing.mdx`, `guides/bundle-diffing.mdx` (patches from earlier OTA
  bundles; the first update reuses unchanged built-in files), `guides/rollout-cohorts.mdx`, `guides/console.mdx`,
  `custom/hosting/docker.mdx` and `storage-adapters/cloudflare.mdx`.
- **react-native-update**:
  [reactnativecn/react-native-update v10.63.0](https://github.com/reactnativecn/react-native-update/tree/v10.63.0)
  `README.md` (server: a hosted service or a paid private deployment; the SDK's `resetToPackagedBundle`) and
  `src/NativePushy.ts` (patches from the bundle inside the binary).

## Status

Pre-release. The server, CLI, bundle diffing, operations commands and container image are built and tested on
workerd and Node; npm releases come later on the roadmap. Conformance runs stock `expo-updates` release apps on an
Android emulator against a local Tide (`pnpm conformance`, outside the gate), and its scenarios are still being
added. [docs/roadmap.md](docs/roadmap.md) has every phase and its state.

## Development

Requires Node 26 and pnpm 12. [CONTRIBUTING.md](CONTRIBUTING.md) has the rules.

```sh
pnpm install
pnpm gate        # every check CI runs, as JSON
```

## License

[MIT](LICENSE)
