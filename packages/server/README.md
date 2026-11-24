# @tide-ota/server

**A self-hosted Expo Updates server for Cloudflare Workers or any container.**

Serve over-the-air updates to React Native apps that use stock [`expo-updates`](https://docs.expo.dev/versions/latest/sdk/updates/),
from your own bucket:

- **No signing key on the server.** Updates are signed when you publish with [`@tide-ota/cli`](https://www.npmjs.com/package/@tide-ota/cli),
  so a compromised server cannot make your apps run new code.
- **No database.** One R2 or S3-compatible bucket holds everything; the server only reads it.
- **Small downloads.** Bundle diffing, including from the bundle inside your store build.
- **Tested with real apps.** Release builds on expo-updates 55 and 58, on Android and iOS.

```sh
npm install @tide-ota/server
```

## Cloudflare Workers

```ts
// worker.ts
export { default } from "@tide-ota/server/workers";
```

Bind the bucket as `BUCKET` (R2) and an Analytics Engine dataset as `ANALYTICS` in `wrangler.jsonc`, and set
`TIDE_APP_ID` if you want requests checked against your app. A complete project is in
[`examples/operator`](https://github.com/HashimTheArab/tide/tree/main/examples/operator).

## Node or a container

```sh
TIDE_DISK_DIR=/srv/tide-bucket node node_modules/@tide-ota/server/dist/node.js
```

Use `TIDE_S3_ENDPOINT`, `TIDE_S3_REGION`, `TIDE_S3_BUCKET`, `TIDE_S3_ACCESS_KEY_ID` and `TIDE_S3_SECRET_ACCESS_KEY`
(read-only keys) instead of `TIDE_DISK_DIR` for an S3-compatible bucket. `PORT` defaults to 8787 and `GET /hc` is the
health check. It records nothing unless `TIDE_ANALYTICS=stdout`, which writes one JSON line per update check on stdout
([fields](https://github.com/HashimTheArab/tide/blob/main/docs/design.md#observability)). The repository also has a [Dockerfile](https://github.com/HashimTheArab/tide/blob/main/packages/server/Dockerfile).

## Your app

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

Setup, domains and keys: [the deploy guide](https://github.com/HashimTheArab/tide/blob/main/docs/deploy.md). How Tide compares with EAS Update and other
servers: [the Tide README](https://github.com/HashimTheArab/tide#comparison).
