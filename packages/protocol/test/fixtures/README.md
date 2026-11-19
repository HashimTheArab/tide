# Fixtures

Tests compare these bytes exactly.

Regenerate `certificate.pem`, the signed Tide multiparts and the `.reply.json` stored replies wrapping them with a
fresh in-memory key: `node packages/protocol/test/generate-fixtures.ts [--out <dir>]`. `--replies-only` rewraps the
committed multiparts without signing. Then check the certificate's code-signing profile
once with `openssl verify -CAfile certificate.pem -purpose codesign certificate.pem`.

`expo-directive.json`, `expo-chain.pem` (leaf then intermediate) and the signature in `expo.multipart` come from
`packages/expo-updates/ios/Tests` in [expo/expo@54c0d6f6](https://github.com/expo/expo/tree/54c0d6f6e9ef537280831b68e5c236807facb641/packages/expo-updates/ios/Tests),
copyright 650 Industries, Inc., MIT licence in `LICENSE-expo`.
