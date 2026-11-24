---
status: draft
updated: 2026-11-24
---

# Getting started

Publish a first update. You need Node 24.11 or later. [Deploying](deploy.md) covers the full production setup.

## 1. Run the server

### On Cloudflare Workers

In your Worker project:

```sh
npm install @tide-ota/server
npm install --save-dev wrangler
```

Copy `worker.ts` and `wrangler.jsonc` from [`examples/operator/`](../examples/operator/), and set the Worker names,
bucket names and `TIDE_APP_ID`. Then:

```sh
npx wrangler r2 bucket create <bucket>
npx wrangler deploy --env staging
```

Always pass `--env`: without it, the Worker has no bucket.

### With Node or a container

```sh
npm install @tide-ota/server
TIDE_DISK_DIR=/srv/tide-bucket node node_modules/@tide-ota/server/dist/node.js
```

This serves a local directory on port 8787. For an S3-compatible bucket, set the `TIDE_S3_*` variables instead
([all variables](deploy.md#the-container)).

### Your domains

Give the server and the bucket's assets each a domain you own. Both go into signed updates on users' devices,
so they must keep working while those builds are installed.

## 2. Set up the app

Make a signing certificate ([step 5](deploy.md#setting-up-an-environment)), then point the app at the server:

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

The channel header is required. A runtime version with nothing published gets a signed reply saying no update
is available.

## 3. Publish an update

```sh
npm install --save-dev @tide-ota/cli
npx tide export --project-root <app> --out <dir>    # builds the app; needs no secrets
npx tide publish --from <dir> --channel main        # signs and uploads; runs no app code
```

`tide publish` reads the bucket, the signing key, the build's certificate, `TIDE_SERVER_URL` and `TIDE_ASSET_URL` from
the environment. In CI, run the two commands as separate jobs, one publish at a time
([a complete CI setup](deploy.md#publishing)).

Check what an installed app would see:

```sh
npx tide probe --server-url https://updates.example.com --channel main --runtime-version 1.0.0 --platform ios
```

## 4. Make downloads smaller

Set `updates.enableBsdiffPatchSupport` in the app, and Tide will serve patches from earlier updates. To patch
from the bundle inside a store build too, so a fresh install's first update is small, register that build once:

```sh
npx tide register-build --platform android --runtime-version 1.0.0 \
  --manifest app.manifest --bundle index.android.bundle --assets-dir <dir>
```

[Patches](design.md#patches) says which files to take from an APK or an `.app`. Hermes apps can also
[compile against the store build's bundle](deploy.md#delta-compiles).

## Where to go next

- [Commands](../packages/cli/README.md) for rollouts, rollbacks and checks
- [Deploying](deploy.md) for accounts, domains, CI and the container
- [Operating Tide](agents.md) for when an update goes wrong
