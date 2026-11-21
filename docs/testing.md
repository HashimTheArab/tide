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

`pnpm conformance --platform android|ios` runs stock `expo-updates` release apps against a local Tide (the Node entry
over a disk store) with a signing identity generated per run. The gate does not run it: it needs an emulator or
simulator and a native build per version. `pnpm conformance --help` lists the options.

- **Versions:** the oldest expo-updates line with bsdiff support (opt-in, which the app enables) and the latest
  stable. `conformance/apps/sdk-<n>` pins each.
- **Scenarios:** the embedded build gets no update; a first update downloads the full bundle because no patch exists;
  a patch from the running OTA update; a tampered patch falls back to the full bundle; a rollback returns to the
  embedded update; a patch from the embedded bundle.
- **Android** runs nightly and on demand in `.github/workflows/conformance.yml`: one job per version on a hosted Linux
  runner, with an AVD created in the run and a KVM-accelerated emulator. **iOS** runs on a Mac before each release
  ([release checklist](release.md)).

## Reviewers reject

Snapshots, sleeps, raised timeouts, retries, `.only` or skips; mocks of our own code; a fix without a test that fails
on the old code; a server behaviour tested on one runtime only; asserting a re-serialised object where bytes matter.
