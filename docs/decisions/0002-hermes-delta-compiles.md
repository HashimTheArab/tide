---
status: decided
updated: 2026-11-22
---

# 0002 Hermes delta compiles

## Decision

- **Build it.** `tide export` gains an opt-in delta compile (P13.3): the launch bundle is compiled with the app's own
  hermesc, Expo's flags and `-base-bytecode=<base .hbc>`, where the base is a bundle file the operator supplies.
  Publish, patch generation and the wire format do not change.
- **Base:** the newest OTA update's launch bundle is the recommended base. In the study it never grew another base's
  total; an embedded base grew the OTA update's by about a third on the small apps.
- **Hook:** a hermesc that Expo finds through `REACT_NATIVE_OVERRIDE_HERMES_DIR`, so the delta compile runs on exactly
  the JS and flags Expo compiles.

## Why

- **Size.** On Bluesky's social-app, the bytes clients download across the measured changes fall by 37.0% with an OTA
  compile base and by 54.1% with an embedded one, counting every base Tide patches from. The bar was a third.
- **Correctness.** A delta-compiled bundle is a complete Hermes bytecode file. The base only steers how its strings and
  functions are laid out, so the bytes line up with the base's. Devices that never ran the base run it like any other bundle (below).

## Measure

The bar is judged on the bytes clients download across the three measured changes (one line, a dependency bump, a
feature), for each compile base kind (the previous OTA update, or the embedded bundle). The sum counts once each base a
device can run when the update is published: the OTA base, the embedded bundle, and an older OTA update built from
the embedded build's source. Each term is the kept patch's bytes; the target's gzip-9 size when Tide keeps no patch
(`keepsPatch`) or has none; and 0 when the device already holds the target. Every patch is `makeBsdiff` output that
passed `checkPatch`. Bases are weighted equally, since the share of devices on each base differs by app.

| App | Compile base | From OTA base | From embedded | From older OTA | All bases | Saved |
| --- | --- | --- | --- | --- | --- | --- |
| sdk-55 | OTA | 97,610 → 8,457 | 848,408 → 795,796 | 183,228 → 134,842 | 1,129,246 → 939,095 | 16.8% |
| sdk-55 | embedded | 97,610 → 131,066 | 848,408 → 654,487 | 183,228 → 12,067 | 1,129,246 → 797,620 | 29.4% |
| sdk-58 | OTA | 128,215 → 26,853 | 1,269,174 → 871,694 | 226,181 → 174,544 | 1,623,570 → 1,073,091 | 33.9% |
| sdk-58 | embedded | 128,215 → 169,580 | 1,269,174 → 549,422 | 226,181 → 31,865 | 1,623,570 → 750,867 | 53.8% |
| Bluesky | OTA | 4,736,108 → 438,084 | 10,158,357 → 8,538,024 | 4,870,939 → 3,477,755 | 19,765,404 → 12,453,863 | 37.0% |
| Bluesky | embedded | 4,736,108 → 3,519,642 | 10,158,357 → 5,071,128 | 4,870,939 → 473,368 | 19,765,404 → 9,064,138 | 54.1% |

Bytes are plain → delta-compiled. sdk-58's feature patch from the embedded bundle to the plain bundle (357,362 B) fails
the keep rule, so that term is the bundle's gzip-9 size, 693,349 B.

From the compile base alone, Bluesky's patches shrink by 90.8% (OTA) and 50.1% (embedded). The cost to the other
bases: on Bluesky every base still gets smaller patches in total, though the one-line change compiled against the OTA
base grows the patches from the embedded bundle and the older OTA update by about 3% and 8%. On the conformance apps, an OTA compile base never grows
another base's total; an embedded compile base grows the OTA base's by 34.3% (sdk-55) and 32.3% (sdk-58).

Per change, plain → delta bytes (`*`: not kept, so clients download the full bundle):

| App | Change | Compile base | From compile base | From other base | From older OTA |
| --- | --- | --- | --- | --- | --- |
| sdk-55 | one-line | OTA | 704 → 704 | 263,428 → 263,428 | 43,055 → 43,055 |
| sdk-55 | one-line | embedded | 263,428 → 215,898 | 704 → 41,499 | 43,055 → 2,132 |
| sdk-55 | dependency-bump | OTA | reused → reused | 263,338 → 263,338 | 43,000 → 43,000 |
| sdk-55 | dependency-bump | embedded | 263,338 → 215,836 | reused → 41,113 | 43,000 → 2,096 |
| sdk-55 | feature | OTA | 96,906 → 7,753 | 321,642 → 269,030 | 97,173 → 48,787 |
| sdk-55 | feature | embedded | 321,642 → 222,753 | 96,906 → 48,454 | 97,173 → 7,839 |
| sdk-58 | one-line | OTA | 4,431 → 1,520 | 288,415 → 287,036 | 51,513 → 50,505 |
| sdk-58 | one-line | embedded | 288,415 → 178,961 | 4,431 → 48,712 | 51,513 → 3,168 |
| sdk-58 | dependency-bump | OTA | reused → 220 | 287,410 → 287,411 | 50,425 → 50,433 |
| sdk-58 | dependency-bump | embedded | 287,410 → 179,011 | reused → 47,712 | 50,425 → 3,132 |
| sdk-58 | feature | OTA | 123,784 → 25,113 | 357,362\* → 297,247 | 124,243 → 73,606 |
| sdk-58 | feature | embedded | 357,362\* → 191,450 | 123,784 → 73,156 | 124,243 → 25,565 |
| Bluesky | one-line | OTA | 883,618 → 54,442 | 2,739,885 → 2,823,217 | 1,024,463 → 1,108,977 |
| Bluesky | one-line | embedded | 2,739,885 → 1,635,429 | 883,618 → 1,121,659 | 1,024,463 → 87,691 |
| Bluesky | dependency-bump | OTA | 1,776,920 → 174,969 | 3,559,325 → 2,841,024 | 1,777,932 → 1,161,067 |
| Bluesky | dependency-bump | embedded | 3,559,325 → 1,701,375 | 1,776,920 → 1,182,232 | 1,777,932 → 175,133 |
| Bluesky | feature | OTA | 2,075,570 → 208,673 | 3,859,147 → 2,873,783 | 2,068,544 → 1,207,711 |
| Bluesky | feature | embedded | 3,859,147 → 1,734,324 | 2,075,570 → 1,215,751 | 2,068,544 → 210,544 |

Raw results, bundle sizes, gzip-9 sizes and keep outcomes: [sdk-55](../assets/hermes-delta/sdk-55.md),
[sdk-58](../assets/hermes-delta/sdk-58.md), [Bluesky](../assets/hermes-delta/bluesky.md) (JSON beside each), from
`pnpm hermes-delta` (`conformance/src/hermes-delta/`). Bluesky is pinned at `17393322eec4`; all bundles are Android.

## Toolchain

- **hermesc:** the `hermes-compiler` package react-native depends on, `hermesc/<os>-bin/hermesc`, which Expo runs
  when nothing overrides it. sdk-55: release 0.14.1, bytecode version 96. sdk-58 and Bluesky: release 260318099.0.5,
  bytecode version 99.
- **`expo export` flags:** `-emit-binary -out <tmp>/index.hbc <tmp>/index.js -O`.
- **Embedded build flags** (React Native Gradle plugin `BundleHermesCTask`, template defaults):
  `-w -emit-binary -max-diagnostic-width=80 -out <bundle>.hbc <bundle> -O -output-source-map`.
- **Delta flags:** Expo's, plus `-base-bytecode=<base .hbc>`.
- **How `expo export` makes bytecode:** Metro serializes the bundle; when the `bytecode` transform option is on,
  `@expo/metro-config/build/serializer/exportHermes.js` `buildHermesBundleAsync` (called from `hermesArtifacts.js` and
  `chunking/Chunk.js` on SDK 58, `serializeChunks.js` on SDK 55) writes the JS to
  `<tmpdir>/expo-bundler-<random>-<time>/index.js`, runs hermesc, reads the `.hbc` and deletes the directory. hermesc
  embeds the input path, so every export's bytes differ even from the same JS.
- **Hook point:** `buildHermesBundleAsync` takes no extra hermesc arguments, and the JS `expo export --no-bytecode`
  writes is not the JS it compiles. So a delta compile hooks in through `REACT_NATIVE_OVERRIDE_HERMES_DIR`: a hermesc
  under that directory gets Expo's exact command and JS and adds `-base-bytecode`. The study captures each compile this
  way and recompiles on fixed relative names.

## Correctness

Question: does a bundle compiled against one base run and verify on a device that never ran that base, such as one on
the embedded build or on another OTA update? **Answer: yes.**

- **Self-contained.** The app's hermesc (`-b -dump-bytecode`) loads each delta bundle of the emulator run alone, in a
  directory without its base, and reads it to the end. Its header has the same bytecode version, source hash and
  function count as the plain compile of the same JS; the HBC header has no field that names a base. The delta has
  a few more strings (1 on sdk-55, 4 on sdk-58) and is 112 and 192 B larger. Its bytecode version (96 on
  sdk-55, 99 on sdk-58) is the embedded bundle's, and the runtime's: react-native builds Hermes from the same release
  as `hermes-compiler` (`sdks/hermes-engine/version.properties`).
- **Verified like any bundle.** The base never reaches the device. Publish applies every patch it stores and checks
  that the result hashes to the launch asset's SHA-256 (`checkPatch`), and the client checks that hash again. So a
  device ends with the same bytes from any base, and the signed manifest, its signature and the hash check do not
  change.
- **Runs on devices that never ran the base.** `pnpm hermes-delta --emulator` builds each conformance app's release
  APK (code signing and bsdiff on) and runs it on an arm64 emulator against a local Tide over a disk store. It
  publishes an OTA base that no device runs, then the feature change delta-compiled against it; the patch from the
  base falls from 97,117 to 7,661 B (sdk-55) and from 124,236 to 25,689 B (sdk-58). On both apps the delta update
  launches and reports its marker on a device on another OTA update and on a device on the embedded build, each
  through Tide's patch and through the full bundle after a tampered patch. The conformance checks verify every
  manifest reply's signature, and Tide never got a request that named the base. Results:
  [sdk-55](../assets/hermes-delta/emulator-sdk-55.md), [sdk-58](../assets/hermes-delta/emulator-sdk-58.md).

## Rejected

- **Plain bsdiff only:** leaves a third to a half of the large app's download in place.
- **One delta compile per base:** a manifest names one launch bundle hash, so each base would need its own update and
  the server would pick per device; patches already serve every base from one bundle.
- **Compiling in `tide publish` against a bundle read from the bucket:** hermesc comes from the project's
  `node_modules`, and publish holds the signing key and bucket credentials, so it runs no project code; export does
  and holds no credentials.
- **`expo export --no-bytecode`, then Tide's hermesc:** that JS differs from what Expo compiles, so the update would
  not be the program a plain export ships.

## Revisit

If a Hermes release changes `-base-bytecode` or the bytecode format, if Expo stops resolving hermesc through
`REACT_NATIVE_OVERRIDE_HERMES_DIR`, or if operators' own updates save less than a third.
