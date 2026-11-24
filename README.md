# Tide

**A serverless Expo Updates server for Cloudflare Workers or any container.**

[![CI](https://github.com/HashimTheArab/tide/actions/workflows/ci.yml/badge.svg)](https://github.com/HashimTheArab/tide/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tide-ota/cli)](https://www.npmjs.com/package/@tide-ota/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Tide is a self-hosted alternative to EAS Update. It sends over-the-air updates to React Native apps that use
[`expo-updates`](https://docs.expo.dev/versions/latest/sdk/updates/), from a bucket you own.

[Getting started](docs/getting-started.md) · [Documentation](docs/README.md) · [Releases](https://github.com/HashimTheArab/tide/releases)

## Features

- **Stock client:** works with `expo-updates` as Expo ships it, with no SDK to swap in and no Expo account
- **No database:** one R2 or S3-compatible bucket holds everything
- **Signed updates:** you sign when you publish, with a key file or AWS KMS, so the server never holds a signing key
- **Small downloads:** bsdiff patches from earlier updates and from the bundle inside your store build; Hermes apps can
  go further ([70% less on Bluesky's Android app](docs/decisions/0002-hermes-delta-compiles.md))
- **Staged rollouts:** send an update to a share of devices, then raise it, finish it or revert it
- **Rollbacks:** return to an earlier update or to the store build
- **Key rotation:** replace a signing certificate without a new store build, using certificate chains
- **Built for CI:** JSON output, exit codes to branch on, a live server check and failure stats
- **Tested with real apps:** every release runs on an Android emulator and an iOS simulator first

## Example

The Worker:

```ts
export { default } from "@tide-ota/server/workers";
```

Publishing an update:

```sh
npx tide export --out ../update                       # builds the app, needs no secrets
npx tide publish --from ../update --channel main      # signs and uploads it
```

[Getting started](docs/getting-started.md) covers the rest: the bucket, the certificate and the app config.

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

Tide is pre-1.0. Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems
privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
