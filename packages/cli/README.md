# @tide-ota/cli

**Publish signed Expo OTA updates to your own R2 or S3 bucket.**

The `tide` command for [Tide](https://github.com/HashimTheArab/tide), a self-hosted Expo Updates server: build and sign updates, roll back, and keep
downloads small with bundle diffing.

```sh
npm install --save-dev @tide-ota/cli
```

## Publish

Two steps, so the one that holds your keys never runs your app's code:

```sh
npx tide export --project-root <app> --out <dir>    # builds the app; needs no secrets
npx tide publish --from <dir> --channel main        # signs and uploads; runs no app code
```

`tide publish` signs with a key from `TIDE_SIGNING_KEY_FILE`, `TIDE_SIGNING_KEY` or AWS KMS (`TIDE_KMS_*`), checks
every signature against your app's certificate, and writes to the bucket named by `TIDE_S3_*` or `TIDE_DISK_DIR`.

For smaller patches on Hermes apps, `tide export --platform android --base-bytecode android=<index.android.bundle>`
compiles the update against the bundle inside your store build, the same file you give `tide register-build`. Export
each platform on its own, and do this for every update of that runtime version. It compiles with the app's hermesc
from react-native and hermes-compiler, so it refuses `--pass-env REACT_NATIVE_OVERRIDE_HERMES_DIR`
([publishing](https://github.com/HashimTheArab/tide/blob/main/docs/deploy.md#delta-compiles)).

## Certificate

Your app trusts one code-signing certificate. `tide certificate --common-name <name> --validity-years <n>` makes it
with the same signing key, so a key created inside AWS KMS never leaves it. It reads only the signing key variables
and the files you name, prints the certificate on stdout and its SHA-256 on stderr, and writes no file itself. For a
certificate chain, `tide certificate --ca` makes a CA root, and `tide certificate --issuer <chain.pem> --subject-key
<public-key.pem>` issues an intermediate (with `--ca`) or a leaf under it. An app that embeds the root publishes in chain mode:
set `TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN=true` and give the leaf and its intermediates in
`TIDE_CERTIFICATE_CHAIN_FILE`.

It holds your signing key, so never run it with your app's own `npx tide`. Install Tide outside your app and check it
first, as in [Signing identity](https://github.com/HashimTheArab/tide/blob/main/docs/deploy.md#setting-up-an-environment).

## Other commands

| Command                         | What it does                                                |
| ------------------------------- | ----------------------------------------------------------- |
| `tide publish --rollout <p>`    | Sends a new update to a share of devices                    |
| `tide publish --add-identity`   | Adds a new signing key, on its own runtime version          |
| `tide rollout`                  | Raises a rollout's share, sends it to everyone, or stops it |
| `tide certificate`              | Makes your app's code-signing certificate with your key     |
| `tide register-build`           | Lets fresh installs get a patch instead of the whole bundle |
| `tide rollback --embedded`      | Sends apps back to the bundle inside the store build        |
| `tide rollback --to <updateId>` | Serves an earlier update again                              |
| `tide republish <updateId>...`  | Serves stored updates again, optionally on another channel  |
| `tide status`                   | Lists what each channel serves right now                    |
| `tide storage`                  | Lists files nothing uses any more; deletes nothing          |
| `tide probe`                    | Checks a live server the way an installed app would         |
| `tide stats`                    | Counts update checks and failures; Workers only             |

`tide publish --json` prints one JSON document for scripts to read, and so do `tide rollout --json`,
`tide rollback --json`, `tide republish --json`, `tide status --json`, `tide storage --json`, `tide probe --json` and
`tide stats --json`
([fields](https://github.com/HashimTheArab/tide/blob/main/docs/design.md#json-output)). During a rollout,
`tide probe --rollout-side new --rollout-update <updateId>` checks the update being sent out.

`tide stats` reads your Worker's Analytics Engine points with a read-only token: `TIDE_ANALYTICS_TOKEN` (Account
Analytics Read), `TIDE_ANALYTICS_ACCOUNT_ID` and, unless it is `tide_manifest`, `TIDE_ANALYTICS_DATASET`. The Node
server's checks are not there. It counts checks, not devices, and exits 0 reported, 2 usage, 3 unreachable, 4 a
refusing status and 5 an unparseable reply. Given
`tide stats --update <updateId> --max-failed-share <percent> --min-checks <n>` it exits 10 for a bad update and 0 for
an ok one or not enough checks. `tide stats --print-sql` prints the queries and sends nothing
([details](https://github.com/HashimTheArab/tide/blob/main/docs/design.md#tide-stats)).

The server is [`@tide-ota/server`](https://www.npmjs.com/package/@tide-ota/server). CI setup, keys and every flag:
[publishing](https://github.com/HashimTheArab/tide/blob/main/docs/deploy.md#publishing) and [the CLI reference](https://github.com/HashimTheArab/tide/blob/main/docs/design.md#cli).
