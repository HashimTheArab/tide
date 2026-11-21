---
status: draft
updated: 2026-11-22
---

# Comparison sources

The sources behind the comparison table in the [README](../README.md), checked on 2026-11-22. Every ✅ and ❌ in
that table, Tide's column included, was verified against the project's own documentation and code at the versions
below; a ❌ also covers features the project's own docs do not mention.

Sources, checked on 2026-11-22:

- **EAS Update**: `docs/pages/eas-update/` in
  [expo/expo@aa82194](https://github.com/expo/expo/tree/aa82194f82a84173211b2b832b9249b0cfd2b1ef/docs/pages/eas-update):
  `introduction.mdx`, `code-signing.mdx`, `bundle-diffing.mdx` and `rollouts.mdx`.
- **xprem** (formerly expo-open-ota):
  [mercuretechnologies/xprem v3.2.7](https://github.com/mercuretechnologies/xprem/tree/v3.2.7) `README.md`, and its
  documentation for v3.2.0: [Keys](https://mercure-technologies.gitbook.io/xprem/key-store/keys),
  [Stateless mode](https://mercure-technologies.gitbook.io/xprem/stateless-mode/overview) and
  [Bundle diffing](https://mercure-technologies.gitbook.io/xprem/features/bundle-diffing-bsdiff).
- **Xavia OTA**: [xavia-io/xavia-ota@4558c9c](https://github.com/xavia-io/xavia-ota/tree/4558c9c61007940673ff90a505b0822a8dc45f3e) `README.md`,
  `docs/supportedStorageAlternatives.md` and `pages/api/manifest.ts` (the server signs each manifest with its key).
- **Hot Updater**: [gronxb/hot-updater v1.1.0](https://github.com/gronxb/hot-updater/tree/v1.1.0) `README.md` and
  `docs/content/docs/(latest)/`: `guides/bundle-signing.mdx`, `guides/bundle-diffing.mdx`,
  `guides/rollout-cohorts.mdx`, `guides/console.mdx` and `storage-adapters/cloudflare.mdx`.
