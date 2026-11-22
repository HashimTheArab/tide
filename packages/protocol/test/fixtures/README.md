# Fixtures

Tests compare these bytes exactly.

Regenerate `certificate.pem`, the signed Tide multiparts, the `.reply.json` stored replies wrapping them and the
chain goldens with fresh in-memory keys: `node packages/protocol/test/generate-fixtures.ts [--out <dir>]`.
`--replies-only` rewraps the committed multiparts without signing. Then check the certificate's code-signing profile
once with `openssl verify -CAfile certificate.pem -purpose codesign certificate.pem`.

The chain goldens come from `chainFixtures` in `../fixtures.ts`: `chain-root.pem` (CA, pathLen 1),
`chain-intermediate.pem` (CA, pathLen 0, linked by key identifiers), `chain-leaf.pem` under it, `chain-short-leaf.pem`
directly under the root, `chain-served.pem` (leaf then intermediate, the served part), `chain.multipart` (signed by
the leaf with keyid `rotated`) and `chain-short.multipart` (signed by the short leaf, no keyid). Their validity
window is `CHAIN_VALIDITY` and the tests verify at `CHAIN_NOW`.
Check them with `openssl verify -attime 1924992000 -CAfile chain-root.pem -untrusted chain-intermediate.pem -purpose
codesign chain-leaf.pem`.

`manifest-next.multipart` (from `manifest-next.json`: another update ID, a later `createdAt`, branch `next`) is framed
with its own boundary, `tide_fixture_next`. It is the new side of the version-2 rollout goldens
`rollout-manifest.reply.json` (12.5%, earlier `manifest.reply.json`), `rollout-rollback.reply.json` (50%, earlier
`rollback.reply.json`) and `rollout-none.reply.json` (0.01%, no earlier reply).

`compat-v1-*.reply.json` are the version-1 stored replies as the encoder wrote them before version 2 existed. Their
bodies are signed by an earlier certificate; they pin the version-1 bytes and are never regenerated.

`expo-directive.json`, `expo-chain.pem` (leaf then intermediate) and the signature in `expo.multipart` come from
`packages/expo-updates/ios/Tests` in [expo/expo@54c0d6f6](https://github.com/expo/expo/tree/54c0d6f6e9ef537280831b68e5c236807facb641/packages/expo-updates/ios/Tests),
copyright 650 Industries, Inc., MIT licence in `LICENSE-expo`.
`expo-chain-root.pem` (the root above `expo-chain.pem`) and the `expo-not-ca-*`, `expo-path-len-*` and
`expo-project-information-*` sets are `chainRoot.pem`, `chainNotCA*`, `chainPathLenViolation*` and
`chainExpoProjectInformationViolation*` from `android/src/shared/certificates` in the expo-updates 58.0.22 npm
package, under the same licence.

`base-update.json`, `base-embedded.json` and `base-embedded-patch.json` are hand-written golden base records;
`base-embedded-patch.json`'s launch hash is `patch-text.base`'s, so the server tests can patch from it.

The patch fixtures come from `node packages/protocol/test/generate-patch-fixtures.ts --bsdiff <path> [--out <dir>]`,
which needs the system `bzip2` and reference bsdiff 4.3 (BSD-2-Clause). Build bsdiff outside the repo from the Debian
orig tarball Homebrew pins (`bsdiff_4.3.orig.tar.gz`, SHA-256
`18821588b2dc5bf159aa37d3bcb7b885d85ffd1e19f23a0c57a58723fea85f48`) with `cc -O2 bsdiff.c -lbz2`. A rerun writes the
same bytes.

- `patch-<name>.base`, `.target`, `.bsdiff`: golden pairs and bsdiff's patch; each patch was also applied once with
  `/usr/bin/bspatch` and matched its target.
- `patch-known.bsdiff`: `KNOWN_PATCH` in `../fixtures.ts`; it applies to any base of 64 bytes or more.
- `patch-bad-*.bsdiff`: variants of `patch-text.bsdiff` that each break one rule.
- `patch-text-extra-group.bsdiff` and `patch-bad-huffman-unused.bsdiff`: `patch-text.bsdiff` with its ctrl block
  rewritten to carry a third Huffman group no selector names, valid or over-subscribed.
- `bzip2-run-control.bz2` decodes to `xaaaa`; `bzip2-run-at-block-end.bz2` is the same block without the run's count
  byte.
- `multiblock.bz2`: several level-1 blocks with long runs.
