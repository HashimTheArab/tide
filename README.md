# Tide

**A serverless Expo Updates server for Cloudflare Workers or any container.**

[![CI](https://github.com/HashimTheArab/tide/actions/workflows/ci.yml/badge.svg)](https://github.com/HashimTheArab/tide/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tide-ota/cli)](https://www.npmjs.com/package/@tide-ota/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Tide is a self-hosted alternative to EAS Update. It sends over-the-air updates to React Native apps that use
[`expo-updates`](https://docs.expo.dev/versions/latest/sdk/updates/), from a bucket you own.

[Getting started](docs/getting-started.md) · [Documentation](docs/README.md) · [Releases](https://github.com/HashimTheArab/tide/releases)

## Features

- Uses stock `expo-updates`. No SDK swap, no Expo account.
- Updates are signed when you publish them, with a key file or AWS KMS. The server never holds the key.
- Devices can [download a bsdiff patch](docs/getting-started.md#4-make-downloads-smaller) against an earlier update or
  the bundle inside the store build. Hermes apps can also compile updates against that bundle, which
  [cut downloads by 70% on Bluesky's Android app](docs/decisions/0002-hermes-delta-compiles.md).
- Send an update to a share of devices first, then raise, finish or revert it. Roll back to an earlier update or to the
  store build.
- If the app embeds a CA root, you can replace the signing certificate without a new store build.
- No database. Everything is in one R2 or S3-compatible bucket.
- CI jobs can publish, check the live server and, on Workers, count failed updates. Every result has JSON output and an
  exit code to branch on.
- Every release is tested with real apps on an Android emulator and an iOS simulator.

## Example

The Worker is one line:

```ts
export { default } from "@tide-ota/server/workers";
```

Publishing:

```sh
npx tide export --out ../update                       # builds the app, needs no secrets
npx tide publish --from ../update --channel main      # signs and uploads it
```

[Getting started](docs/getting-started.md) covers setup: bucket, certificate and app config.

## Comparison

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
| Staged rollouts | ✅ | ✅ | ✅² | ❌ | ✅ |

❌ also means the project's own docs do not mention it. Sources: [docs/comparison.md](docs/comparison.md).

1. Only on Expo's Production and Enterprise plans.
2. xprem needs PostgreSQL for diffing and rollouts. Its stateless mode drops PostgreSQL, has neither feature and reads
   channels from Expo's API.

## Contributing

Tide is pre-1.0. Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security
problems privately: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
