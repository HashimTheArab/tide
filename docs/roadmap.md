---
status: draft
updated: 2026-11-22
---

# Roadmap

Each phase ships through the [delivery loop](delivery-loop.md), run with `sliceLines: 1500` and `maxRounds: 5` so
each plans as one PR. P2 to P5 and P10 to P12 are risky: each gets a design note and the deep review. P11 and P12 change the wire format
and the stored reply, so they run one at a time; P10 can run beside P12.

| Phase | Scope | State |
| --- | --- | --- |
| P1 | Workspace: tooling, gate, CI, docs, delivery loop, Workers and Node entry points with a health check | done |
| P2 | `packages/protocol`: manifest and directive types, multipart encode and parse, signature sign and verify, asset hashing, golden fixtures | done |
| P3 | Server: `Store` with R2, S3 and disk adapters; `/manifest`, `/assets?h=`, `/hc`; the same tests on workerd and Node | done |
| P4 | CLI: `publish` (export, hash, upload, compose, sign with a file, env or KMS key, one serialized CI writer, conditional pointer write, `createdAt` guard, asset key identity check), `rollback`, `republish`, `status`, `storage` (read-only report; nothing is deleted) | done |
| P5 | Bundle diffing: `register-build`, `BSDIFF40` generation with self-check, `/bundles/<hash>` patch negotiation | done |
| P6 | Operations: analytics data point per manifest request, `tide probe`, a published Workers entry with an example deploy setup and `wrangler deploy --dry-run` in the gate (Tide never deploys anything live), container image with a smoke test, and publishing split into a secret-free `tide export` and a sign-and-upload step | done |
| P7 | Conformance: nightly Android emulator apps on expo-updates 55 and 58 (update, patch from OTA and embedded, rollback, corrupt patch); iOS simulator before each release | done |
| P8 | Public repository: a README for first-time visitors with a verified comparison table, LICENSE, SECURITY.md, CONTRIBUTING.md, issue and PR templates, and package metadata (nothing published) | done |
| P9 | npm releases with provenance | done |
| P10 | KMS certificates: `tide certificate` writes the self-signed code-signing certificate with the configured key source (file, env or KMS) signing it, so a key created inside KMS (`--origin AWS_KMS`) never exists anywhere else; the deploy guide gains that path beside key import | pending |
| P11 | Certificate chains: an app can embed a CA root and set `codeSigningIncludeManifestResponseCertificateChain`; each signed reply then carries a `certificate_chain` part (leaf, then intermediates) that the CLI checks by the client's chain rules before upload; `tide certificate` also issues a root, intermediates and leaves; a new leaf key needs no app release and no new bucket while the root stays; conformance covers a chained app | pending |
| P12 | Staged rollouts: a pointer can hold a rollout (the new reply, the one it replaces, both pre-signed, and a percentage); the server picks per device from a hash of `EAS-Client-ID` salted with the update ID, and a request without one gets the earlier reply; `tide publish --rollout <percent>` and `tide rollout <percent>\|complete\|revert`; servers read the new stored reply version before any CLI writes it; analytics records the side served | pending |
| P13 | Hermes delta study: measure `hermesc -base-bytecode` against plain bsdiff on the conformance apps and a large open-source app, from OTA and embedded bases; a decision record; build it into `tide export` only if patches shrink by a third or more | pending |
