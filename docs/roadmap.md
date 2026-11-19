---
status: draft
updated: 2026-11-19
---

# Roadmap

Each phase ships through the [delivery loop](delivery-loop.md). P2 to P6 are risky: every slice waits for the owner.

| Phase | Scope | State |
| --- | --- | --- |
| P1 | Workspace: tooling, gate, CI, docs, delivery loop, Workers and Node entry points with a health check | done |
| P2 | `packages/protocol`: manifest and directive types, multipart encode and parse, signature sign and verify, asset hashing, golden fixtures | pending |
| P3 | Server: `Store` with R2, S3 and disk adapters; `/manifest`, `/assets?h=`, `/hc`; the same tests on workerd and Node | pending |
| P4 | CLI `publish`: export, hash, upload, compose, sign (file, env or KMS key), lock, conditional pointer write, `createdAt` guard | pending |
| P5 | Bundle diffing: `register-build`, `BSDIFF40` generation with self-check, `/bundles/<hash>` patch negotiation | pending |
| P6 | `rollback`, `republish`, `status`, `gc` | pending |
| P7 | Observability: analytics data point per manifest request, synthetic probe | pending |
| P8 | Conformance: nightly Android emulator apps on expo-updates 55 and 57 (update, patch from OTA and embedded, rollback, corrupt patch); iOS simulator before each release | pending |
| P9 | Deploy: `wrangler deploy` from CI on `main` through a protected environment; container image with a smoke test | pending |
| P10 | Public release: verified comparison table in the README, npm releases with provenance | pending |
