---
status: draft
updated: 2026-11-21
---

# Deploying

How an operator runs Tide: a Worker on Cloudflare, or the Node container anywhere. Tide's own repository never
deploys; everything here runs in the operator's repository and accounts. Names below (`example.com`, `tide-example`)
are placeholders.

## The operator project

[`examples/operator/`](../examples/operator/) is the reference, built with `wrangler deploy --dry-run` and tested on
workerd in Tide's gate:

- `package.json` depends on `@tide/server`. Until it is on npm, the project lives in a checkout of Tide's workspace
  like the example.
- `worker.ts` is one line: `export { default } from "@tide/server/workers";`. The Worker is configured only by its
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
   rejects unsigned apps. From the app's directory, write the certificate where the app config reads it and the key
   outside every checkout, never inside a repository:

   ```sh
   npx expo-updates codesigning:generate \
     --certificate-output-directory keys \
     --key-output-directory ~/tide-signing/main \
     --certificate-validity-duration-years 10 \
     --certificate-common-name "Example App"
   ```

   The key goes only to the writer job (Publishing), as `TIDE_SIGNING_KEY_FILE`,
   `TIDE_SIGNING_KEY` or `TIDE_KMS_KEY_ID`. Every writer, `register-build` included, and `tide probe` read the
   builds' identity from `TIDE_BUILD_KEYID` and one of `TIDE_BUILD_CERTIFICATE_FILE` or `TIDE_BUILD_CERTIFICATE`,
   taken from a shipped binary.
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
(`publish --from`, `rollback`, `republish`, `register-build`) start no process (`design.md`, CLI). The two run in
separate jobs of one workflow:

- **Export job.** A GitHub-hosted runner; `permissions: contents: read`; no `environment`, no `secrets.*`, no
  `id-token`, and no credential in its environment, files or profiles. It checks out the app and Tide at a pinned
  commit, both with `persist-credentials: false` (otherwise `actions/checkout` leaves the job token in `.git/config`,
  where project code can read it), runs `tide export --out <dir>`, and uploads `<dir>` with `actions/upload-artifact`, exposing its
  `artifact-id` output as a job output. Expo's tools get only an allowlisted environment (`design.md`, CLI); pass
  anything else the app config needs with `--pass-env`.
- **Writer job.** `needs` the export job and runs in the protected environment holding the key and bucket secrets.
  - **Runner.** GitHub-hosted, or a self-hosted runner freshly provisioned or reset for each job: a just-in-time
    registration limits a runner to one job, but a reused host keeps files and processes from earlier ones. Never a
    runner that could have run an export job. GitHub, Security hardening: hosted runners "execute code within
    ephemeral and clean isolated virtual machines"; self-hosted runners "can be persistently compromised by untrusted
    code in a workflow".
  - **Trusted CLI.** It checks out only Tide, at a commit SHA written in the workflow file (never one the export job
    chose), with `persist-credentials: false`. Node comes from that checkout's `.nvmrc` and pnpm from its
    `package.json` (`pnpm/action-setup` with `package_json_file`; Node 26 does not bundle Corepack). From that
    checkout it runs `pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@tide/cli..."`, then
    `node packages/cli/src/main.ts publish --from <path> --channel <name>`. The app is never checked out; it is
    present only as artifact data.
  - **Binding.** A step fails when the export job's `artifact-id` is empty. `actions/download-artifact` takes it as
    `artifact-ids` (not `name`), with `digest-mismatch: error` and `path` a fresh directory under
    `${{ runner.temp }}`, outside the Tide checkout. A single artifact by ID is "extracted directly to the specified
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
      node packages/cli/src/main.ts publish --from "$RUNNER_TEMP/export" --channel main || status=$?
      if [ "$status" -ne 1 ]; then exit "$status"; fi
      sleep 30
    done
    exit 1
    ```

The writer job also reads `TIDE_BUILD_KEYID` and the build certificate, and refuses an export whose certificate or
`keyid` is not the builds'. What it cannot prove is that the directory is the one this run exported: that is the
binding above.

**One concurrency group.** Every writer for a bucket is a job in one repository sharing one `concurrency` group with
`cancel-in-progress: false` and `queue: max`; the export job is outside it. GitHub does not guarantee queue order
([Workflow syntax, `concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)),
so the head check, not the queue, keeps older code from publishing over newer.

**Recovery.** A writer retries itself in the same job while it exits 1, so it keeps the group's slot. Exit 2 wrote
nothing. Never use Re-run on a writer job: the rerun queues again, so another writer can run before it. If a job
still ends without exit 0 (timeout, cancellation or runner loss), start a new run at the branch head. It starts from
what the bucket holds (`design.md`, Bucket configuration). For `register-build`, `design.md`'s key check is the
backstop.

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

## The container

`packages/server/Dockerfile` runs the Node entry. Build it from the repository root with BuildKit, which reads
`packages/server/Dockerfile.dockerignore`; a builder that reads only the root `.dockerignore` gets an empty context
and fails:

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
