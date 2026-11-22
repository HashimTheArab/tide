---
status: draft
updated: 2026-11-22
---

# Deploying

How an operator runs Tide: a Worker on Cloudflare, or the Node container anywhere. Tide's own repository never
deploys; everything here runs in the operator's repository and accounts. Names below (`example.com`, `tide-example`)
are placeholders.

## The operator project

[`examples/operator/`](../examples/operator/) is the reference, built with `wrangler deploy --dry-run` and tested on
workerd in Tide's gate:

- `package.json` depends on `@tide-ota/server` from npm (`npm install @tide-ota/server`) and on `wrangler`. The
  example links the workspace copy instead, so the gate tests it against the current source.
- `worker.ts` is one line: `export { default } from "@tide-ota/server/workers";`. The Worker is configured only by its
  bindings and vars.
- `wrangler.jsonc` has a top-level `name`, `main` and `compatibility_date`, and one block per environment under
  `env`. Wrangler does not inherit bindings or vars into a named environment, so `staging` and `production` each
  declare `name`, `vars.TIDE_APP_ID`, the R2 binding `BUCKET` and the Analytics Engine binding `ANALYTICS`.
  Every deploy passes `--env`: without it the Worker has no bindings, and `/manifest` answers 503.
- `TIDE_APP_ID`, when not empty, makes the Worker refuse a request whose `expo-app-id` differs; leave it empty to
  accept any.

## Accounts and domains

**One Cloudflare account per environment.** Deploying a Worker needs only `Editor` on it: "You do not need separate
permissions on the bound resources to deploy the Worker" (Cloudflare, Workers authorization). A staging deploy in
the production account could therefore bind the production bucket. Staging and production each get their own
account, Worker, bucket, deploy token and publisher credential. One account is fine for a trial with no production
data, at that cost.

**One zone per account.** An R2 custom domain must be a zone in the bucket's account, so each environment needs a
domain of its own: for example `example.com` in the production account and `example-staging.com` in the staging
account. Add the zones before choosing URLs.

**Permanent URLs.** The server and asset origins are inside signed manifests on devices, and the server origin is in
every shipped build. They must keep serving for as long as an installed build can hold a manifest naming them, so
they are domains the operator controls, never `workers.dev` or `r2.dev` hostnames tied to an account. `r2.dev` is
also rate-limited and meant for development only.

## Setting up an environment

Once per environment, in this order.

1. **Bucket.** `wrangler r2 bucket create <bucket>`, matching the environment's `bucket_name`. Analytics Engine
   creates the dataset on its first write.
2. **First deploy, by an administrator.** Creating a Worker needs product-level `Admin`, a per-Worker role cannot be
   granted before the Worker exists, and attaching a Custom Domain also needs *Zone* > *Workers Routes* > *Write*
   on its zone. An administrator runs `wrangler deploy --env <name>` once and attaches the server domain (for
   example `updates.example.com`) to the Worker in the dashboard. The example config declares no routes, so later
   deploys leave the connection alone.
3. **Deploy token.** An account API token with the per-Worker `Editor` role on this Worker only. It can deploy
   new versions but cannot create Workers or change domains.
4. **Asset domain.** Connect a custom domain (for example `assets.example.com`) to the bucket's public access.
   `https://assets.example.com/assets/<hex>` then serves the object `assets/<hex>`. Every object in the bucket
   becomes public; Tide stores nothing secret there. Connect it before the first publish.
5. **Signing identity.** A self-signed certificate per environment with its `keyid` (`design.md`, Keys). Tide
   rejects unsigned apps. Put the certificate where the app config reads it (here `keys/certificate.pem`), made one
   of two ways:

   - **`tide certificate`**, signed by the key the writers will use: a KMS key created in KMS (`design.md`, KMS
     provisioning) or a file key kept outside every checkout. It holds that key or a `kms:Sign` session, so never run
     the app's own `npx tide`. Install Tide into fresh directories outside the app checkout with the writer job's
     checks (Publishing, Trusted CLI). The subshell stops at the first failure, so npm installs nothing that failed
     verification:

     ```sh
     (
       set -e
       mkdir ~/tide-pkgs ~/tide-cli && cd ~/tide-pkgs
       for p in cli protocol; do
         npm pack --registry https://registry.npmjs.org/ "@tide-ota/$p@0.1.0"
         gh attestation verify "tide-ota-$p-0.1.0.tgz" --repo HashimTheArab/tide --deny-self-hosted-runners \
           --cert-identity https://github.com/HashimTheArab/tide/.github/workflows/release.yml@refs/tags/v0.1.0
       done
       npm install --prefix ~/tide-cli --offline --ignore-scripts --no-fund \
         ./tide-ota-cli-0.1.0.tgz ./tide-ota-protocol-0.1.0.tgz
     )
     ```

     Then run it outside the app checkout with that source's variables set; for KMS, also `TIDE_KMS_ACCESS_KEY_ID`,
     `TIDE_KMS_SECRET_ACCESS_KEY` and `TIDE_KMS_SESSION_TOKEN` from a session allowed `kms:GetPublicKey` and
     `kms:Sign`. Copy only the printed certificate into the app:

     ```sh
     mkdir -p ~/tide-signing/main
     TIDE_KMS_KEY_ID=alias/tide-main TIDE_KMS_REGION=us-east-1 \
       ~/tide-cli/node_modules/.bin/tide certificate --common-name "Example App" --validity-years 10 \
       > ~/tide-signing/main/certificate.pem
     ```

   - **`expo-updates codesigning:generate`**, from the app's directory, writing the key outside every checkout, never
     inside a repository; for KMS, import that key afterwards (`design.md`, Key import):

     ```sh
     npx expo-updates codesigning:generate \
       --certificate-output-directory keys \
       --key-output-directory ~/tide-signing/main \
       --certificate-validity-duration-years 10 \
       --certificate-common-name "Example App"
     ```

   Either way, the app config names the certificate and its `keyid` (The app). The key goes only to the writer job
   (Publishing), as `TIDE_SIGNING_KEY_FILE`, `TIDE_SIGNING_KEY` or `TIDE_KMS_KEY_ID`. Every writer, `register-build`
   included, and `tide probe` read the builds' identity from `TIDE_BUILD_KEYID` and one of
   `TIDE_BUILD_CERTIFICATE_FILE` or `TIDE_BUILD_CERTIFICATE`, taken from a shipped binary.

   **Chain path.** Instead of one self-signed certificate, the app can embed a CA root and trust any leaf the root
   issues, so the writer's key can change without an app release or a new bucket. Each step runs the same trusted
   `tide` install, with only the named key source set:

   | Step | Key source set | Command | Output |
   | --- | --- | --- | --- |
   | 1 | none | create the root key, an optional intermediate key and the writer's leaf key: separate KMS keys, or files outside every checkout | three keys |
   | 2 | root key | `tide certificate --ca --common-name "Example Root CA" --validity-years 20` | `root.pem` |
   | 3 (optional) | root key | `tide certificate --ca --issuer root.pem --subject-key intermediate.pub --common-name "Example Intermediate CA" --validity-years 10` | `intermediate.pem` |
   | 4 | intermediate key | `cat intermediate.pem root.pem > issuer.pem`, then `tide certificate --issuer issuer.pem --subject-key leaf.pub --common-name "Example Writer 2027" --validity-days 365` | `leaf.pem` |
   | 4, without step 3 | root key | `tide certificate --issuer root.pem --subject-key leaf.pub --common-name "Example Writer 2027" --validity-days 365` | `leaf.pem` |

   A `.pub` file is the key's SubjectPublicKeyInfo PEM: `openssl pkey -in <key> -pubout`, or for KMS
   `aws kms get-public-key --key-id <key> --query PublicKey --output text | base64 -d | openssl pkey -pubin -inform DER`.

   - **Keys.** The root and intermediate keys, and any credential allowed to `Sign` with them, never go to the
     writer job. The writer gets only the leaf key (`kms:Sign` on that key alone).
   - **The writer.** It gets `TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN=true`, `root.pem` as the build certificate, and the
     served chain in `TIDE_CERTIFICATE_CHAIN_FILE` (or `TIDE_CERTIFICATE_CHAIN`): `leaf.pem`, or
     `cat leaf.pem intermediate.pem`, never the root. `tide probe` takes the same two pins. The app config sets
     `updates.codeSigningIncludeManifestResponseCertificateChain: true` beside `codeSigningCertificate: "./keys/root.pem"`,
     for `tide export` to record and for the app's config plugin to read.
   - **The app.** It embeds `root.pem` as its certificate and must opt in to chains: Android meta-data
     `expo.modules.updates.CODE_SIGNING_INCLUDE_MANIFEST_RESPONSE_CERTIFICATE_CHAIN` set to `true`, and the iOS
     `Expo.plist` key `EXUpdatesCodeSigningIncludeManifestResponseCertificateChain` set to `true`. Expo's config
     plugins (SDK 58) do not set either from app config, so a prebuild project needs its own config plugin to write
     them. Without the opt-in, the app verifies replies with the root's key and refuses every leaf signature.
   - **A leaked leaf key.** Issuing a new leaf lets the writer switch keys, but it does not revoke the old one: apps
     trusting the root still accept replies signed by the leaked key, served with its old chain, until that leaf
     or a certificate above it expires. Keep leaf lifetimes short. A leaked intermediate key can issue leaves until
     the intermediate expires; a leaked root key needs a new app build with a new root.
   - **Leaf rotation.** Issue the next leaf before the current one expires and switch the writer's key and served
     chain together; the bucket keeps serving bodies the old leaf signed, and the next publish, republish or rollback
     re-signs `reply/no-update`. Before the old leaf expires, publish or republish each live channel and finish or
     replace each rollout, since a stored reply keeps the chain it was signed with.
   - **Renewal.** An expired root or intermediate breaks every build that embeds or is served it. A new certificate
     never outlives one above it, so in an ancestor's last year issue leaves with `--validity-days`. The bucket binds
     its `keyid` to the root's exact certificate, so a reissued root, even with the same key, ships with a new
     `keyid` and bucket.
6. **Publisher credential.** An R2 Object Read & Write token scoped to the bucket, given to the publish workflow as
   the five `TIDE_S3_*` variables in a protected CI secret (`design.md`, Bucket configuration). The publisher's
   `TIDE_SERVER_URL` is the server origin and `TIDE_ASSET_URL` the asset origin.
7. **Check before shipping builds.** Run `tide export`, then `tide publish --from` (an empty bucket answers
   `/manifest` with 503; publish also writes `reply/no-update`), then `tide probe` with the builds' channel and runtime version for each published
   platform, and expect a manifest each time. The probe does not fetch non-launch assets, so fetch one asset URL
   from the served manifest too. Only then ship builds pointing at the origins.

## The app

A build selects its update by URL, channel and runtime version, and trusts it by certificate. With the placeholders
above, the production app config holds:

```js
{
  runtimeVersion: "1.0.0", // Or a policy; it must resolve to the runtime tide export records.
  updates: {
    url: "https://updates.example.com/manifest",
    requestHeaders: { "expo-channel-name": "main" }, // The channel tide publish --channel writes.
    codeSigningCertificate: "./keys/certificate.pem",
    codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
  },
}
```

A request without `expo-channel-name` is a 400. A runtime with nothing published gets a signed `noUpdateAvailable`,
so a mismatched runtime looks healthy until the probe, run with the build's own values, finds no manifest.

## Publishing

Only `tide export` runs project code (the app config, Babel and Metro), and it reads no credential. The writers
(`publish --from`, `rollout`, `rollback`, `republish`, `register-build`) start no process (`design.md`, CLI). The two run in
separate jobs of one workflow:

- **Export job.** A GitHub-hosted runner; `permissions: contents: read`; no `environment`, no `secrets.*`, no
  `id-token`, and no credential in its environment, files or profiles. It checks out the app with
  `persist-credentials: false` (otherwise `actions/checkout` leaves the job token in `.git/config`, where project code
  can read it), installs the app's dependencies, `@tide-ota/cli` among them, runs `npx tide export --out <dir>`, and
  uploads `<dir>` with `actions/upload-artifact`, exposing its `artifact-id` output as a job output. Expo's tools get
  only an allowlisted environment (`design.md`, CLI); pass anything else the app config needs with `--pass-env`.
- **Writer job.** `needs` the export job and runs in the protected environment holding the key and bucket secrets.
  - **Runner.** GitHub-hosted, or a self-hosted runner freshly provisioned or reset for each job: a just-in-time
    registration limits a runner to one job, but a reused host keeps files and processes from earlier ones. Never a
    runner that could have run an export job. GitHub, Security hardening: hosted runners "execute code within
    ephemeral and clean isolated virtual machines"; self-hosted runners "can be persistently compromised by untrusted
    code in a workflow".
  - **Trusted CLI.** It fetches `@tide-ota/cli` and `@tide-ota/protocol`, the CLI's only dependency, at one exact
    version written in the workflow file and kept equal to the app's (never one the export job chose), into a fresh
    directory under `${{ runner.temp }}`, and runs them on a Node version the CLI's `engines` allows, from
    `actions/setup-node`. `gh attestation verify` checks that each tarball was signed by a GitHub Actions certificate
    for Tide's `release.yml` at that version's tag on a GitHub-hosted runner, and fails when a package has no
    attestation. Use `--cert-identity`, an exact match: `--signer-workflow` only matches a prefix. npm then installs
    those two checked files and nothing else: `--offline` fails rather than fetch anything. The app is never checked
    out; it is present only as artifact data. Give the step `GH_TOKEN: ${{ github.token }}`:

    ```sh
    mkdir "$RUNNER_TEMP/tide-pkgs" && cd "$RUNNER_TEMP/tide-pkgs"
    for p in cli protocol; do
      npm pack --registry https://registry.npmjs.org/ "@tide-ota/$p@0.1.0"
      gh attestation verify "tide-ota-$p-0.1.0.tgz" --repo HashimTheArab/tide --deny-self-hosted-runners \
        --cert-identity https://github.com/HashimTheArab/tide/.github/workflows/release.yml@refs/tags/v0.1.0
    done
    npm install --prefix "$RUNNER_TEMP/tide" --offline --ignore-scripts --no-fund \
      ./tide-ota-cli-0.1.0.tgz ./tide-ota-protocol-0.1.0.tgz
    echo "$RUNNER_TEMP/tide/node_modules/.bin" >> "$GITHUB_PATH"
    ```

  - **Binding.** A step fails when the export job's `artifact-id` is empty. `actions/download-artifact` takes it as
    `artifact-ids` (not `name`), with `digest-mismatch: error` and `path` a fresh directory under
    `${{ runner.temp }}`, outside the CLI's directory. A single artifact by ID is "extracted directly to the specified
    path" (`actions/download-artifact` v8.0.2 README).
  - **Head check.** Once, at the start of the job and before downloading, a publish checks through the GitHub API
    that its commit is still the branch head, as [`examples/deploy-workers.yml`](examples/deploy-workers.yml) does
    for deploys, so neither a late approval nor a run the queue let past a newer one publishes older code over newer.
  - **KMS through OIDC.** `id-token: write` lets the job request a token; Tide needs the AWS session it is exchanged
    for. `aws-actions/configure-aws-credentials` with `role-to-assume`, `output-credentials: true` and
    `output-env-credentials: false`; then pass its `aws-access-key-id`, `aws-secret-access-key` and
    `aws-session-token` outputs as `TIDE_KMS_ACCESS_KEY_ID`, `TIDE_KMS_SECRET_ACCESS_KEY` and
    `TIDE_KMS_SESSION_TOKEN`, beside `TIDE_KMS_KEY_ID` and `TIDE_KMS_REGION`.
  - **Retry in place.** The writer command runs in a loop in one step, with the same arguments and the same
    downloaded directory. Exit 0 or 2 ends the step with that status; exit 1 retries after a short pause. Every
    attempt runs while the job holds the group's slot, so no other writer runs between them. `register-build` has no
    attempt limit (`while :; do`), so only the job's `timeout-minutes` bounds it (`design.md`, One writer at a time):

    ```sh
    for attempt in 1 2 3 4 5; do
      status=0
      tide publish --from "$RUNNER_TEMP/export" --channel main || status=$?
      if [ "$status" -ne 1 ]; then exit "$status"; fi
      sleep 30
    done
    exit 1
    ```

The writer job also reads `TIDE_BUILD_KEYID`, `TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN` and the build certificate, and
refuses an export whose certificate, `keyid` or chain mode is not the builds'. What it cannot prove is that the directory is the one this run exported: that is the
binding above.

**One concurrency group.** Every writer for a bucket (`publish`, `rollout`, `rollback`, `republish` and
`register-build`) is a job in one repository sharing one `concurrency` group with
`cancel-in-progress: false` and `queue: max`; the export job is outside it. GitHub does not guarantee queue order
([Workflow syntax, `concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)),
so the head check, not the queue, keeps older code from publishing over newer. A bucket's writers share its group
whatever keyid they sign for.

**Recovery.** A writer retries itself in the same job while it exits 1, so it keeps the group's slot. Exit 2 wrote
nothing. Never use Re-run on a writer job: the rerun queues again, so another writer can run before it. If a job
still ends without exit 0 (timeout, cancellation or runner loss), start a new run at the branch head. It starts from
what the bucket holds (`design.md`, Bucket configuration). For `register-build`, `design.md`'s key check is the
backstop.

### Delta compiles

On a Hermes app, the export job can compile each update against the bundle inside the store build, so patches from
every base shrink ([0002](decisions/0002-hermes-delta-compiles.md): 70% fewer bytes on a large app once every update
does it):

```sh
npx tide export --out "$RUNNER_TEMP/export" --platform android --base-bytecode android=index.android.bundle
```

Export and publish each platform on its own: a based export takes one `--platform` and one base.

- **The base** is the file you give `tide register-build --bundle` for that platform's release build of the runtime
  version being published. Keep it in the repository or a build artifact the export job reads; it needs no secret.
  Use the same base for every update of a runtime, never an OTA update's bundle: a delta compile keeps every string of
  its base, so a moving base grows each update.
- **Strings of the base become public.** Hermes copies the base's whole string table into the update, including
  strings the update no longer uses. Anything in the store build's bundle is published with every update.
- **Tide cannot tell the right base.** A matching bytecode version only proves hermesc can read the file. A wrong
  base (another platform, build or runtime) still gives a correct bundle that every device runs, only larger patches
  and that base's strings in the update.
- Export refuses a missing base, a file that is not Hermes bytecode, and a base of another bytecode version than the
  app's hermesc, before running Expo. It runs on macOS and Linux.
- It compiles with the app's hermesc from react-native and hermes-compiler, so it refuses `--pass-env
  REACT_NATIVE_OVERRIDE_HERMES_DIR`.

### Staged rollouts

Deploy the server first: the stored record a rollout writes is read only by servers from the same release
([Upgrade order](#upgrade-order)). Then publish to a share of devices, picked per install by `EAS-Client-ID`:

```sh
tide publish --from "$RUNNER_TEMP/export" --channel main --rollout 10
tide rollout 50 --channel main --runtime-version 1.0.0
tide rollout complete --channel main --runtime-version 1.0.0
```

- `tide rollout` is a writer: run it as a job in the same concurrency group, in the same retry loop as publish. It
  signs nothing, so it needs the build pins and the bucket but no signing key.
- A percentage only rises. Lowering it would never move a device back (a client applies only a newer `createdAt`),
  so it is refused. `tide rollout revert` serves the earlier reply to every device that has not yet taken the new
  update; devices already on it stay there. To move those back too, use `tide rollback --to <earlier updateId>` or
  `tide rollback --embedded`, or publish a fix.
- `complete` and `revert` end a rollout. The next `tide publish --rollout` starts another over a complete one; over
  one in progress or reverted it refuses, so finish it or replace it with a plain publish, republish or rollback.
- `tide probe` sends no `EAS-Client-ID`, so below 100% it checks the earlier side, and `tide status` prints each
  rollout's percentage and both sides.

## Routine deploys

Staging deploys from `main`; production deploys a commit only after staging has run it. Wrangler runs in the
operator project's directory, which holds Wrangler and `wrangler.jsonc`; the workspace root has neither.

- **Workers Builds.** In each account, connect the repository to that environment's Worker with Root directory set
  to the operator project's folder (for example `examples/operator`) and the deploy command
  `npx wrangler deploy --env <name>`. Staging's Git branch is `main`; production's is a release branch moved forward
  to a commit staging has run. Each account holds its own connection, so no token leaves Cloudflare.
- **GitHub Actions.** [`examples/deploy-workers.yml`](examples/deploy-workers.yml): a `staging` job on push to `main`
  and a `production` job after it. Each job reads `secrets.CLOUDFLARE_API_TOKEN` and `vars.CLOUDFLARE_ACCOUNT_ID`
  from its own GitHub environment, so production's protection rules decide when its token can be read. Each
  environment has a concurrency group whose runs queue in order, and each job checks that its commit is still the
  head of `main` before it deploys, so a rerun or a late approval cannot replace a newer deploy with an older one.

How production is gated depends on the GitHub plan:

| Repository | Production gate |
| --- | --- |
| Public, any plan; private on Enterprise | `production` environment with required reviewers; the token is an environment secret |
| Private on Pro or Team | `production` environment limited to the protected `main` branch; the token is an environment secret; review happens in the pull request that branch protection requires |
| Private on Free | No environment secrets or protection rules. Use Workers Builds, or accept that anyone with write access can deploy, with the token as a repository secret |

### Upgrade order

A release whose CLI writes a new stored reply version (`design.md`, Stored replies) needs servers that read it first.
Deploy a server release that reads the version to every server sharing the bucket, staging and production, Workers
and containers, before raising the CLI version pinned in the publish workflow to one that writes it. Version 2
(rollouts) is read by servers and written by the CLI (`tide publish --rollout`, `tide rollout`) from the same
release, so deploy that server everywhere before using any CLI that writes version 2. Never roll a server or the
pinned CLI back below that release while any pointer holds the version, a complete or reverted rollout included: an
older server answers 503 for that pointer and an older CLI refuses to write over it, so first replace each such
pointer with a plain publish, republish or rollback.
Version 3 (several signing identities) is read by servers before any CLI writes it: deploy a server that reads it
everywhere first.

## The container

The Node entry runs from the npm package in any image with a supported Node:

```sh
npm install @tide-ota/server
node node_modules/@tide-ota/server/dist/node.js
```

Tide's repository also has a reference image, `packages/server/Dockerfile`, tested by CI's `container` job. Build it
from a checkout's root with BuildKit, which reads `packages/server/Dockerfile.dockerignore`; a builder that reads only
the root `.dockerignore` gets an empty context and fails:

```sh
docker build -f packages/server/Dockerfile -t tide .
docker run --read-only -p 8787:8787 -v /srv/tide-bucket:/bucket:ro -e TIDE_DISK_DIR=/bucket tide
```

| Variable | Meaning |
| --- | --- |
| `PORT` | Listening port; default `8787` |
| `TIDE_DISK_DIR` | A bucket directory, for a single host |
| `TIDE_S3_ENDPOINT`, `TIDE_S3_REGION`, `TIDE_S3_BUCKET`, `TIDE_S3_ACCESS_KEY_ID`, `TIDE_S3_SECRET_ACCESS_KEY` | An S3-compatible bucket; all five, and read-only credentials with `s3:GetObject` and `s3:ListBucket` (without ListBucket a missing key is a 403, which Tide answers with 503) |
| `TIDE_APP_ID` | Optional; as for the Worker |

Exactly one store is configured; otherwise the container exits 1 naming what is wrong. The image holds no
configuration or credential: pass them at run time, from the orchestrator's secret store.

- It runs as uid 1000 (`node`) over root-owned files, and works with a read-only root filesystem. A disk bucket must
  be readable by uid 1000; mount it read-only.
- `GET /hc` is the health check.
- On `SIGTERM` or `SIGINT` it stops accepting connections, lets in-flight replies finish and exits 0. A client that
  stalls is cut off when the orchestrator's grace period ends.
- Node records no analytics.
- `TIDE_SERVER_URL` is the container's public origin. `TIDE_ASSET_URL` is the bucket's public domain (S3) or, on
  disk, a static origin such as `https://assets.example.com` where `https://assets.example.com/assets/<hex>` serves
  `TIDE_DISK_DIR/assets/<hex>` with each object's type. Tide adds `/assets/` itself, as in step 4 of Setting up an
  environment (`design.md`, Other routes).
