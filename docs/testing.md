---
status: decided
updated: 2026-11-22
---

# Testing standard

What agents must test, how, and what reviewers reject.

## Shape

- **Default to an integration test through the public surface:** HTTP requests to the real app, and CLI commands
  against real local storage. Unit tests only for pure protocol rules.
- **Both runtimes.** Server behaviour tests run on workerd (`test/workers`) and Node (`test/node`). Shared cases
  live in one module both projects import.
- **Real, then fake, never mock.** No `vi.mock` or `vi.fn` stand-ins for our own modules or the storage layer. Use
  the disk adapter or the Workers R2 binding. Fake only providers we do not run (a KMS), one fake per interface.
- **Assert outcomes:** status, headers and exact body bytes; stored objects and their bytes.

## Wire format

- **Golden fixtures.** Signed parts, manifests, directives and patches live as files. Tests compare bytes, not
  re-parsed objects.
- **Verify like the client.** A signature test verifies against an X.509 certificate with Web Crypto. A patch test
  applies the patch and checks the SHA-256 of the result.
- **Properties** (fast-check): multipart encode and parse round-trip; any manifest signed then verified passes and any
  flipped byte fails; a patch from any base reproduces its target. Fixed seed in the gate, random nightly
  (`FC_SEED=<n>` replays). Commit every counterexample as an example.

## Concurrency

Writers run one at a time from CI (`docs/design.md`, CLI), so tests cover the backstops: a pointer write against a
stale ETag fails cleanly, and a write with an unknown outcome leaves the next run able to start from what the bucket
holds.

## Conformance

Real `expo-updates` clients (Android emulator nightly, iOS simulator before release) against a local Tide: update, no
update, rollback, patch from an OTA update and from the embedded bundle, missing patch, corrupt patch.

## Packages

`pnpm test:pack` installs each packed tarball alone into a fresh npm project, with the `@tide-ota` registry
unreachable, and runs the `tide` bin, the Node server and a TypeScript consumer from them, so an internal dependency a
manifest leaves out fails the run. It runs as its own CI job.

## Reviewers reject

Snapshots, sleeps, raised timeouts, retries, `.only` or skips; mocks of our own code; a fix without a test that fails
on the old code; a server behaviour tested on one runtime only; asserting a re-serialised object where bytes matter.
