# Security

Tide delivers code to users' devices, so we treat security reports as the most important issues we get.

## Reporting a vulnerability

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/HashimTheArab/tide/security/advisories/new). Do not open a
public issue, pull request or discussion. Include the affected component and commit, how to reproduce it, and the
impact you see. We will reply in the advisory, agree a fix and a disclosure date with you, and credit you unless you
ask us not to.

## Scope

- `packages/server`: the Workers and Node entries, the container image and the storage adapters
- `packages/protocol`: manifests, multipart bodies, signatures and patches
- `packages/cli`: export, signing, key handling, publishing and every command that writes the bucket
- `examples/operator` and the deployment guidance in `docs/`

Out of scope: an app that ships without a code-signing certificate (Tide requires code signing), an operator's own
infrastructure, credentials or configuration, the `conformance/` harness, and bugs in dependencies with no impact on
Tide (report those upstream).

## Supported versions

Tide has no releases yet. Only the `main` branch is supported, and fixes land there.

Reports are handled on a best-effort basis, with no response-time commitment.
