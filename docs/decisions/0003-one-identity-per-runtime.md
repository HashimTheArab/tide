---
status: decided
updated: 2026-11-23
---

# 0003 One signing identity per runtime

## Decision

- **One identity per runtime.** A store build that changes its signing identity (a new key, certificate or chain
  root) ships under a new `keyid` and a new runtimeVersion, on the same bucket and `updates.url`. A pointer
  `reply/<channel>/<runtime>/<platform>` holds one identity's replies, version 1 or 2, served to every request.
- **Version 3 only at `reply/no-update`.** Every runtime shares it, so it holds one entry per keyid, picked by the
  request's `expo-expect-signature` keyid. Only `tide publish --add-identity` converts a version-1 record, by a
  conditional write before any pointer, keeping the existing reply byte for byte.
- **A read-time guard.** Every writer and `register-build` refuses, before any write, a target runtime and platform
  that another keyid's pointer holds on any channel. It catches an operator's mistake; it does not fence late or
  concurrent writes, which the one concurrency group and the operator rule prevent.
- **No direct-mode certificate binding.** A direct keyid is its keyid plus its key, as in a single-identity bucket.
  This supersedes design.md's "One certificate per keyid" for direct mode. Chain-mode root bindings stay, and a direct
  writer refuses a keyid that a root binding holds.

## Why

- expo-updates checks signatures only at download, and its launcher picks the newest downloaded update whose
  runtimeVersion matches the build without verifying it again. A build that switches identity but keeps its
  runtimeVersion can launch the old identity's cached update; a new runtimeVersion keeps them apart on the device.
- A chain-mode client ignores the signature's keyid, so routing a pointer by keyid cannot keep its manifest apart from
  another identity's. One identity per runtime needs no routing below `reply/no-update`.
- No pointer holds two identities, so a direct binding protects nothing on the wire, and after a conversion it would
  refuse the old identity's own writer.

## Rejected

- **Version-3 pointers routed by keyid** (P11.4, P11.5): chain clients ignore the keyid, and a same-runtime switch
  still launches the old identity's update.
- **`--existing-certificate`**, binding a direct keyid's certificate before conversion: no direct binding is left.
- **Owner records, locks or fencing per runtime:** a lease in a bucket cannot stop a delayed write (design.md, CLI),
  and the guard exists for the operator's mistake, not for racing jobs.

## Revisit

If expo-updates verifies a stored update again at launch, or filters launches by keyid.
