---
status: draft
updated: 2026-11-22
---

# Releasing

The checks before each release. A failed step stops the release until a fix lands on `main`.

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
