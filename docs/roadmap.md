---
status: draft
updated: 2026-11-20
---

# Roadmap

Each phase ships through the [delivery loop](delivery-loop.md), run with `sliceLines: 1500` and `maxRounds: 5` so
each plans as one PR. P2 to P5 are risky: each gets a design note and the deep review.

| Phase | Scope | State |
| --- | --- | --- |
| P1 | Workspace: tooling, gate, CI, docs, delivery loop, Workers and Node entry points with a health check | done |
| P2 | `packages/protocol`: manifest and directive types, multipart encode and parse, signature sign and verify, asset hashing, golden fixtures | done |
| P3 | Server: `Store` with R2, S3 and disk adapters; `/manifest`, `/assets?h=`, `/hc`; the same tests on workerd and Node | done |
| P4 | CLI: `publish` (export, hash, upload, compose, sign with a file, env or KMS key, one serialized CI writer, conditional pointer write, `createdAt` guard, asset key identity check), `rollback`, `republish`, `status`, `storage` (read-only report; nothing is deleted) | done |
| P5 | Bundle diffing: `register-build`, `BSDIFF40` generation with self-check, `/bundles/<hash>` patch negotiation | done |
| P6 | Operations: analytics data point per manifest request, `tide probe`, a published Workers entry with an example deploy setup and `wrangler deploy --dry-run` in the gate (Tide never deploys anything live), container image with a smoke test, and publishing split into a secret-free `tide export` and a sign-and-upload step | done |
| P7 | Conformance: nightly Android emulator apps on expo-updates 55 and 57 (update, patch from OTA and embedded, rollback, corrupt patch); iOS simulator before each release | pending |
| P8 | Public repository: a README for first-time visitors with a verified comparison table, LICENSE, SECURITY.md, CONTRIBUTING.md, issue and PR templates, and package metadata (nothing published) | pending |
| P9 | npm releases with provenance | pending |
