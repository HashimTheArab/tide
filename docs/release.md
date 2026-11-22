---
status: draft
updated: 2026-11-22
---

# Releasing

[`.github/workflows/release.yml`](../.github/workflows/release.yml) publishes `@tide-ota/protocol`,
`@tide-ota/server` and `@tide-ota/cli` together, at one version, through npm trusted publishing: no npm token exists.

## One-time npm setup

Done on 2026-11-22; nothing here needs doing again unless it is lost or the repository moves.

- The npm organization `tide-ota` owns the scope.
- Each package has placeholder versions `0.0.1` and `0.0.0-stage` with no code, because npm adds a trusted
  publisher only to a package that exists.
- Each package trusts GitHub Actions in `HashimTheArab/tide`, workflow `release.yml`, to publish. Keep the workflow's
  file name: the trust names it.

To redo or check the trust, run these with an npm account that owns the packages and has 2FA enabled, in a real
terminal: npm asks for a web 2FA approval, which needs a TTY.

```sh
for pkg in protocol server cli; do
  npm trust github "@tide-ota/$pkg" --repo HashimTheArab/tide --file release.yml --allow-publish
done
npm trust list @tide-ota/cli
```

A trusted publisher does not stop token publishes. On npmjs.com, set each package's Settings → Publishing access to
"Require two-factor authentication and disallow tokens", and check it after any redo; trusted publishing keeps working.

## Before each release

A failed step stops the release until a fix lands on `main`.

1. **CI passed on the release commit** on `main`: the `gate` and `container` jobs.
2. **Android conformance passed on that commit:** the nightly Conformance run, or one dispatched on `main` from the
   Actions tab. Both expo-updates jobs pass.
3. **iOS conformance passes on a Mac** with Xcode, CocoaPods and the Node and pnpm versions in `engines`, at that
   commit:

   ```sh
   pnpm install
   pnpm conformance --platform ios
   ```

   It uses the booted simulator or boots one (`--simulator` picks another), and must print `pass` for every version
   and scenario and exit 0. Keep its result lines with the release notes.

## Publishing a release

Push a `v<semver>` tag on that commit. A prerelease such as `v0.2.0-rc.1` publishes under the `next` dist-tag and
makes a GitHub prerelease; anything else publishes as `latest`.

```sh
git tag v0.1.0 <commit>
git push origin v0.1.0
```

The workflow's three jobs:

- **build** checks the tag and that its commit is on `main`, runs the gate, and packs the three tarballs at the tag's
  version (the repository stays at `0.0.0`).
- **publish** is the only job with an OIDC token and runs no repository code. It publishes protocol, server and cli
  with provenance, and skips a version npm already holds only when the bytes match.
- **release** creates the GitHub Release and attaches the same tarballs.

If publish or release fails, use **Re-run failed jobs**: they reuse the build's tarballs and skip what already landed
with the same bytes.

## Checking provenance

- **npmjs.com:** each package's page for the new version shows a Provenance section. It must name
  `HashimTheArab/tide`, the tag's commit and a `release.yml` run.
- **npm:** in an empty directory, install the release and check its signatures and attestations:

  ```sh
  npm install @tide-ota/server@0.1.0 @tide-ota/cli@0.1.0
  npm audit signatures
  ```

  Every package must have a verified registry signature, and the three `@tide-ota` packages verified attestations.

## Placeholders

After the first real release, deprecate the placeholders so nobody installs them by accident:

```sh
for pkg in protocol server cli; do
  for v in 0.0.1 0.0.0-stage; do
    npm deprecate "@tide-ota/$pkg@$v" "Placeholder with no code. Install the latest version."
  done
done
```

## If the GitHub owner changes

Trusted publishing matches the repository by name, and npm rejects provenance whose repository differs from the
package's `repository.url`. Before the next release:

- Replace each package's trusted publisher: `npm trust list` gives its id for `npm trust revoke`, then run
  `npm trust github` as above with the new `--repo`.
- Update every reference to the old owner (`git grep HashimTheArab`): `repository`, `homepage` and `bugs` in the
  root and package `package.json` files, the links in the docs, and `--repo` in the commands above.
