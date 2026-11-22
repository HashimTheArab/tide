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

## Other commands

| Command                         | What it does                                                |
| ------------------------------- | ----------------------------------------------------------- |
| `tide register-build`           | Lets fresh installs get a patch instead of the whole bundle |
| `tide rollback --embedded`      | Sends apps back to the bundle inside the store build        |
| `tide rollback --to <updateId>` | Serves an earlier update again                              |
| `tide republish <updateId>...`  | Serves stored updates again, optionally on another channel  |
| `tide status`                   | Lists what each channel serves right now                    |
| `tide storage`                  | Lists files nothing uses any more; deletes nothing          |
| `tide probe`                    | Checks a live server the way an installed app would         |

The server is [`@tide-ota/server`](https://www.npmjs.com/package/@tide-ota/server). CI setup, keys and every flag:
[publishing](https://github.com/HashimTheArab/tide/blob/main/docs/deploy.md#publishing) and [the CLI reference](https://github.com/HashimTheArab/tide/blob/main/docs/design.md#cli).
