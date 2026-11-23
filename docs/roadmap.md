---
status: draft
updated: 2026-11-23
---

# Roadmap

Each phase ships through the [delivery loop](delivery-loop.md), run with `sliceLines: 1500` and `maxRounds: 5` so
each plans as one PR. P2 to P5 and P10 to P12 are risky: each gets a design note and the deep review. P11 and P12 change the wire format
and the stored reply, so they run one at a time; P10 can run beside P12. P14 needs P12's rollout side.

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
| P10 | KMS certificates: `tide certificate` writes the self-signed code-signing certificate with the configured key source (file, env or KMS) signing it, so a key created inside KMS (`--origin AWS_KMS`) never exists anywhere else; the deploy guide gains that path beside key import | done |
| P11 | Certificate chains: an app can embed a CA root and set `codeSigningIncludeManifestResponseCertificateChain`; each signed reply then carries a `certificate_chain` part (leaf, then intermediates) that the CLI checks by the client's chain rules before upload; `tide certificate` also issues a root, intermediates and leaves; a new leaf key needs no app release and no new bucket while the root stays; one bucket and one `updates.url` also serve several signing identities, one per runtimeVersion: a new root or key ships in a new store build with a new `keyid` and runtimeVersion, same bucket and URL; within a channel the runtime and platform select the pointer, and the `keyid` that every signing client sends in `expo-expect-signature` selects only its `reply/no-update` entry; replies already stored keep serving older builds; conformance covers a chained app and two identities with two runtimeVersions on one bucket | pending |
| P12 | Staged rollouts: a pointer can hold a rollout (the new reply, the one it replaces, both pre-signed, and a percentage); the server picks per device from a hash of `EAS-Client-ID` salted with the update ID, and a request without one gets the earlier reply; `tide publish --rollout <percent>` and `tide rollout <percent>\|complete\|revert`; servers read the new stored reply version before any CLI writes it; analytics records the side served | done |
| P13 | Hermes delta study: measure `hermesc -base-bytecode` against plain bsdiff on the conformance apps and a large open-source app, from OTA and embedded bases; a decision record; build it into `tide export` only if patches shrink by a third or more | done |
| P14 | Operability without a dashboard: `--json` (with a schema number; errors stay on stderr, exit codes unchanged) on `status`, `storage`, `probe`, `rollout`, `publish`, `rollback` and `republish`; `tide stats` (Workers only) reads Analytics Engine through the SQL API with a read-only token from the environment, weights counts by `_sample_interval`, reports checks rather than devices (per current update, per failed update ID, per rollout side) over a bounded window, and `--update <id> --max-failed-share <pct> --min-checks <n>` exits non-zero for a bad update; the queries are shown in the docs (`--print-sql`), with no Grafana dashboard file; `tide probe --rollout-side new` picks a client ID on the new side; the Node server gains an opt-in sink writing each analytics point as one JSON line on stdout (no `/metrics`, no OpenTelemetry); `docs/agents.md`, a runbook for people and coding agents, with an example scheduled CI job that runs `tide rollout revert` when the check fails; the server stays read-only (no webhooks, no server-side pause) | pending |
