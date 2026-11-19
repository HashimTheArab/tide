---
status: decided
updated: 2026-11-19
---

# 0001 Architecture

## Decision

- **Protocol:** Expo Updates v1 with the stock `expo-updates` client. No custom client.
- **Signing:** at publish time, in the CLI. The server serves stored bytes and holds no key.
- **Storage:** one R2 or S3-compatible bucket. No database.
- **Server:** TypeScript and Hono. One runtime-free core with two entry points: Cloudflare Workers (default) and
  Node in a container.
- **Bundle diffing:** `BSDIFF40` patches made at publish time, including from embedded bundles, served by the server
  so it sees `A-IM` negotiation.
- **Tooling:** pnpm workspace without a task runner; oxlint (type-aware) and oxfmt; Vitest with
  `@cloudflare/vitest-plugin` for workerd tests; knip; one gate script.

## Why

- Installed apps only speak the Expo protocol, and their client already verifies signatures and hashes, launches
  atomically and falls back after a crash.
- A server that signs can be made to sign attacker code. Publish-time signing limits a compromised server to
  withholding or replaying updates.
- Each request is a header lookup and a stream; a bucket holds all state, so the server scales and moves freely.
- TypeScript is the only language that is first-class on Workers and runs unchanged on Node.
- Three reviewers (Astra, Opus, Fable) independently kept every choice above.

## Rejected

- **xprem (Go):** signs per request, needs Postgres for diffing, calls Expo's API in stateless mode, and cannot run
  on Workers.
- **Server-side signing:** simpler rollbacks and dashboards, but puts the key on an internet-facing server.
- **A database (D1, Postgres):** nothing here needs transactions beyond one conditional pointer write.
- **Rust (`workers-rs`) or Go:** second-class on Workers.
- **Own client (hot-updater, react-native-update model):** needs an app release and abandons installed apps.
- **Turborepo or vite-plus:** unneeded for three packages.

## Revisit

If Cloudflare Workers stops being the main deployment target, or a feature needs per-device server state.
