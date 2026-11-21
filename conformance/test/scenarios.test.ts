import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { Part } from "@tide/protocol";
import {
  NO_UPDATE_KEY,
  decodeStoredReply,
  diskPath,
  encodeMultipart,
  encodeStoredReply,
  parseMultipart,
  patchKey,
} from "@tide/protocol";

import type { Report } from "../src/android.ts";
import type { Scenario } from "../src/options.ts";
import type { Outcome, Served, Trace, Update } from "../src/scenarios.ts";
import type { Stack } from "../src/stack.ts";
import { SCENARIOS } from "../src/options.ts";
import {
  checkCorruptPatch,
  checkEmbedded,
  checkFull,
  checkPatch,
  checkRollback,
  plan,
  runScenarios,
} from "../src/scenarios.ts";
import { tamperPatch, withStack } from "../src/stack.ts";
import { tideCli } from "../src/tide-cli.ts";
import { ANDROID, MAIN, fixtureExport, hexOf, sha256Hex } from "./harness.ts";

const EMBEDDED_ID = "6f1b0c2e-4d3a-4b5c-9e8f-7a6b5c4d3e2f";
const UNSIGNED = `got ${NO_UPDATE_KEY}, which is not signed for the run`;

const served = (stack: Stack): Served => ({
  stack,
  app: {
    version: "55",
    dir: stack.dir,
    packageName: "dev.tide.conformance",
    ...MAIN,
  },
});

/** A 64 KiB random bundle, which gzip cannot shrink, so a patch between two variants passes the size rule. */
const bundle = () => randomBytes(64 * 1024);
/** `base` with `marker` written into it, as two exports of one app differ. */
const variant = (base: Uint8Array, marker: string) => {
  const out = Buffer.from(base);
  out.write(marker, 1000);
  return out;
};

/** Publishes a fixture export whose Android bundle is `bytes` to `channel`. */
async function publish(
  stack: Stack,
  marker: string,
  bytes: Uint8Array,
  channel: string = MAIN.channel,
): Promise<Update> {
  const ids = await tideCli(stack).publish(fixtureExport(stack, marker, bytes), channel);
  return { updateId: ids.android ?? "", marker, hex: await hexOf(bytes), embedded: false };
}

/** Registers an embedded build with no assets whose bundle is `bytes`; the bucket must already serve the identity. */
async function registerBuild(stack: Stack, bytes: Uint8Array): Promise<Update> {
  const dir = join(stack.dir, "build");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.android.bundle"), bytes);
  writeFileSync(join(dir, "app.manifest"), JSON.stringify({ id: EMBEDDED_ID, assets: [] }));
  await tideCli(stack).registerBuild({
    platform: "android",
    runtimeVersion: MAIN.runtimeVersion,
    manifest: join(dir, "app.manifest"),
    bundle: join(dir, "index.android.bundle"),
  });
  return embedded(await hexOf(bytes));
}

const ALL = Object.keys(SCENARIOS) as Scenario[];

const embedded = (hex: string): Update => ({
  updateId: EMBEDDED_ID,
  marker: "e",
  hex,
  embedded: true,
});

const running = (u: Update): Report => ({
  event: "running",
  marker: u.marker,
  updateId: u.updateId,
  embedded: u.embedded,
});
const fetched = (u: Update, isNew: boolean, rollback = false): Report => ({
  event: "fetched",
  marker: u.marker,
  isNew,
  rollback,
});

/** Sends the requests a stock client sends, through the recorder, and returns them with `reports` as a trace. */
async function trace(
  stack: Stack,
  reports: Report[],
  requests: (client: Client) => Promise<void>,
): Promise<Trace> {
  const before = stack.responses.length;
  await requests(client(stack));
  return { reports, recorded: stack.responses.slice(before) };
}

interface Client {
  manifest(current: string, keyId?: string): Promise<void>;
  /** Requests `to`'s launch bundle with A-IM, as a client does first, or without it, as its fallback does. */
  bundle(to: Update, current: string, aIm?: boolean): Promise<void>;
}

function client(stack: Stack): Client {
  const read = async (path: string, headers: Record<string, string>) => {
    await (await fetch(`${stack.serverUrl}${path}`, { headers })).arrayBuffer();
  };
  return {
    manifest: (current: string, keyId = stack.identity.keyId) =>
      read("/manifest", {
        "expo-protocol-version": "1",
        "expo-platform": ANDROID.platform,
        "expo-runtime-version": MAIN.runtimeVersion,
        "expo-channel-name": MAIN.channel,
        "expo-expect-signature": `sig, keyid="${keyId}", alg="rsa-v1_5-sha256"`,
        "expo-current-update-id": current,
      }),
    bundle: (to: Update, current: string, aIm = true) =>
      read(`/bundles/${to.hex}`, {
        ...(aIm && { "a-im": "bsdiff" }),
        "expo-current-update-id": current,
        "expo-requested-update-id": to.updateId,
      }),
  };
}

/** Rewrites the stored no-update reply's body, keeping its boundary. */
function rewriteNoUpdate(
  stack: Stack,
  change: (parts: Part[], boundary: string) => Uint8Array<ArrayBuffer>,
) {
  const path = join(stack.storeDir, diskPath(NO_UPDATE_KEY));
  const { boundary, body } = decodeStoredReply(readFileSync(path));
  const next = change(parseMultipart(body, boundary), boundary);
  writeFileSync(path, encodeStoredReply({ kind: "noUpdateAvailable", boundary, body: next }));
}

/** Flips one character of the stored no-update directive's signature. */
const breakSignature = (stack: Stack) =>
  rewriteNoUpdate(stack, ([part], boundary) => {
    const signature = (part?.signature ?? "").replace(
      /sig="(.)/,
      (_, c: string) => `sig="${c === "A" ? "B" : "A"}`,
    );
    return encodeMultipart(
      [{ name: "directive", body: part?.body ?? new Uint8Array(), signature }],
      boundary,
    ).body;
  });

describe("the embedded scenario", () => {
  /** Two launches of an app on `main` while only another channel has a pointer. */
  async function launches(stack: Stack, e: Update, keyId?: string) {
    const each = () =>
      trace(stack, [running(e), fetched(e, false)], (c) => c.manifest(e.updateId, keyId));
    return [await each(), await each()];
  }

  test("passes when both launches get the stored signed no-update reply", async () => {
    await withStack(async (stack) => {
      const e = embedded(await hexOf(bundle()));
      await publish(stack, "seed", bundle(), "seed");
      await checkEmbedded(served(stack), e, await launches(stack, e));
    });
  });

  test("fails when the reply has the stored boundary but no directive to verify", async () => {
    await withStack(async (stack) => {
      const e = embedded(await hexOf(bundle()));
      await publish(stack, "seed", bundle(), "seed");
      rewriteNoUpdate(stack, (_, boundary) => new Uint8Array(Buffer.from(`--${boundary}--\r\n`)));
      await expect(checkEmbedded(served(stack), e, await launches(stack, e))).rejects.toThrow(
        UNSIGNED,
      );
    });
  });

  test("fails when the directive's signature does not verify under the run's certificate", async () => {
    await withStack(async (stack) => {
      const e = embedded(await hexOf(bundle()));
      await publish(stack, "seed", bundle(), "seed");
      breakSignature(stack);
      await expect(checkEmbedded(served(stack), e, await launches(stack, e))).rejects.toThrow(
        UNSIGNED,
      );
    });
  });

  test("fails when the client did not expect the run's signature", async () => {
    await withStack(async (stack) => {
      const e = embedded(await hexOf(bundle()));
      await publish(stack, "seed", bundle(), "seed");
      await expect(
        checkEmbedded(served(stack), e, await launches(stack, e, "other")),
      ).rejects.toThrow("a /manifest request did not expect the run's signature");
    });
  });
});

describe("the full scenario", () => {
  /** A fresh install running `e` takes `u1` with the full bundle; a relaunch gets no update. */
  async function launches(stack: Stack, e: Update, u1: Update) {
    return [
      await trace(
        stack,
        [running(e), fetched(e, true), running(u1), fetched(u1, false)],
        async (c) => {
          await c.manifest(e.updateId);
          await c.bundle(u1, e.updateId);
          await c.manifest(u1.updateId);
        },
      ),
      await trace(stack, [running(u1), fetched(u1, false)], (c) => c.manifest(u1.updateId)),
    ];
  }

  test("passes on the full bundle and a signed no-update relaunch", async () => {
    await withStack(async (stack) => {
      const e = embedded(await hexOf(bundle()));
      const u1 = await publish(stack, "u1", bundle());
      await checkFull(served(stack), e, u1, await launches(stack, e, u1));
    });
  });

  test("fails when the embedded update is registered, so a patch to the first update is stored", async () => {
    await withStack(async (stack) => {
      await publish(stack, "seed", bundle(), "seed");
      const base = bundle();
      const e = await registerBuild(stack, base);
      const u1 = await publish(stack, "u1", variant(base, "u1"));
      await expect(checkFull(served(stack), e, u1, await launches(stack, e, u1))).rejects.toThrow(
        `a patch to the first update is stored: ${patchKey(e.hex, u1.hex)}`,
      );
    });
  });

  test("fails when the embedded update is registered, though no patch was stored", async () => {
    await withStack(async (stack) => {
      await publish(stack, "seed", bundle(), "seed");
      const e = await registerBuild(stack, bundle());
      // Unrelated bytes: the patch would not save half the transfer, so none is stored.
      const u1 = await publish(stack, "u1", bundle());
      await expect(checkFull(served(stack), e, u1, await launches(stack, e, u1))).rejects.toThrow(
        `the embedded update is registered: bases/${EMBEDDED_ID}`,
      );
    });
  });

  test("fails on a stored patch to the first update from another base, though the client got a 200", async () => {
    await withStack(async (stack) => {
      const base = bundle();
      const u0 = await publish(stack, "u0", base);
      const u1 = await publish(stack, "u1", variant(base, "u1"));
      const e = embedded(await hexOf(bundle()));
      await expect(checkFull(served(stack), e, u1, await launches(stack, e, u1))).rejects.toThrow(
        `a patch to the first update is stored: ${patchKey(u0.hex, u1.hex)}`,
      );
    });
  });

  test("fails when the no-update reply does not verify", async () => {
    await withStack(async (stack) => {
      const e = embedded(await hexOf(bundle()));
      const u1 = await publish(stack, "u1", bundle());
      breakSignature(stack);
      await expect(checkFull(served(stack), e, u1, await launches(stack, e, u1))).rejects.toThrow(
        UNSIGNED,
      );
    });
  });
});

/** A client running `from` takes `to`, its bundle as one request with A-IM. */
const patchedLaunch = (stack: Stack, from: Update, to: Update, current = from.updateId) =>
  trace(stack, [running(from), fetched(from, true), running(to), fetched(to, false)], async (c) => {
    await c.manifest(from.updateId);
    await c.bundle(to, current);
    await c.manifest(to.updateId);
  });

describe("the patch-ota scenario", () => {
  test("passes on the stored patch from the running update", async () => {
    await withStack(async (stack) => {
      const base = bundle();
      const u1 = await publish(stack, "u1", base);
      const u2 = await publish(stack, "u2", variant(base, "u2"));
      await checkPatch(served(stack), u1, u2, await patchedLaunch(stack, u1, u2));
    });
  });

  test("fails with a 200 when the CLI wrote no patch", async () => {
    await withStack(async (stack) => {
      const u1 = await publish(stack, "u1", bundle());
      // Unrelated bytes: the patch would not save half the transfer, so none is stored.
      const u2 = await publish(stack, "u2", bundle());
      await expect(
        checkPatch(served(stack), u1, u2, await patchedLaunch(stack, u1, u2)),
      ).rejects.toThrow(`/bundles/${u2.hex} answered 200, not 226`);
    });
  });
});

describe("the corrupt-patch scenario", () => {
  async function published(stack: Stack) {
    const base = bundle();
    const u2 = await publish(stack, "u2", base);
    const u3 = await publish(stack, "u3", variant(base, "u3"));
    return { u2, u3 };
  }
  const reports = (u2: Update, u3: Update) => [
    running(u2),
    fetched(u2, true),
    running(u3),
    fetched(u3, false),
  ];

  test("passes on the tampered 226, then a full bundle without A-IM naming the same updates", async () => {
    await withStack(async (stack) => {
      const { u2, u3 } = await published(stack);
      const intact = tamperPatch(stack.storeDir, u2.hex, u3.hex);
      const seen = await trace(stack, reports(u2, u3), async (c) => {
        await c.manifest(u2.updateId);
        await c.bundle(u3, u2.updateId);
        await c.bundle(u3, u2.updateId, false);
        await c.manifest(u3.updateId);
      });
      await checkCorruptPatch(served(stack), u2, u3, seen, intact);
    });
  });

  test("fails when the client makes no full-bundle request after the 226", async () => {
    await withStack(async (stack) => {
      const { u2, u3 } = await published(stack);
      const intact = tamperPatch(stack.storeDir, u2.hex, u3.hex);
      const seen = await patchedLaunch(stack, u2, u3);
      await expect(checkCorruptPatch(served(stack), u2, u3, seen, intact)).rejects.toThrow(
        `no fallback: the client never got /bundles/${u3.hex} answered 200`,
      );
    });
  });

  test("fails when the stored patch was never tampered, though a full bundle followed", async () => {
    await withStack(async (stack) => {
      const { u2, u3 } = await published(stack);
      const intact = sha256Hex(
        readFileSync(join(stack.storeDir, diskPath(patchKey(u2.hex, u3.hex)))),
      );
      const seen = await trace(stack, reports(u2, u3), async (c) => {
        await c.manifest(u2.updateId);
        await c.bundle(u3, u2.updateId);
        await c.bundle(u3, u2.updateId, false);
        await c.manifest(u3.updateId);
      });
      await expect(checkCorruptPatch(served(stack), u2, u3, seen, intact)).rejects.toThrow(
        `${patchKey(u2.hex, u3.hex)} is unchanged since before the tamper`,
      );
    });
  });

  test("fails when the 226 carried the untampered patch, though a full bundle followed", async () => {
    await withStack(async (stack) => {
      const { u2, u3 } = await published(stack);
      const c = client(stack);
      const before = stack.responses.length;
      await c.manifest(u2.updateId);
      await c.bundle(u3, u2.updateId);
      const intact = tamperPatch(stack.storeDir, u2.hex, u3.hex);
      await c.bundle(u3, u2.updateId, false);
      await c.manifest(u3.updateId);
      const seen = { reports: reports(u2, u3), recorded: stack.responses.slice(before) };
      await expect(checkCorruptPatch(served(stack), u2, u3, seen, intact)).rejects.toThrow(
        `"body":"${patchKey(u2.hex, u3.hex)}"`,
      );
    });
  });
});

describe("the rollback scenario", () => {
  async function rolledBack(stack: Stack) {
    const u3 = await publish(stack, "u3", bundle());
    await tideCli(stack).rollbackToEmbedded(ANDROID);
    return { u3, e: embedded(await hexOf(bundle())) };
  }
  const requests = (from: Update, e: Update) => async (c: Client) => {
    await c.manifest(from.updateId);
    await c.manifest(e.updateId);
  };

  test("passes when the app reloads into its embedded update and gets the directive again", async () => {
    await withStack(async (stack) => {
      const { u3, e } = await rolledBack(stack);
      const seen = await trace(
        stack,
        [running(u3), fetched(u3, false, true), running(e), fetched(e, false)],
        requests(u3, e),
      );
      await checkRollback(served(stack), u3, e, seen);
    });
  });

  test("fails when the app still reports the OTA update", async () => {
    await withStack(async (stack) => {
      const { u3, e } = await rolledBack(stack);
      const seen = await trace(
        stack,
        [running(u3), fetched(u3, false, true), running(u3), fetched(u3, false)],
        requests(u3, e),
      );
      await expect(checkRollback(served(stack), u3, e, seen)).rejects.toThrow(
        `the app reported ${JSON.stringify(running(u3))}, not ${JSON.stringify(running(e))}`,
      );
    });
  });
});

describe("the patch-embedded scenario", () => {
  test("passes when the 226 names the registered build's update", async () => {
    await withStack(async (stack) => {
      await publish(stack, "seed", bundle(), "seed");
      const base = bundle();
      const e = await registerBuild(stack, base);
      const u4 = await publish(stack, "u4", variant(base, "u4"));
      await checkPatch(served(stack), e, u4, await patchedLaunch(stack, e, u4));
    });
  });

  test("fails when the 226 names another base", async () => {
    await withStack(async (stack) => {
      await publish(stack, "seed", bundle(), "seed");
      const base = bundle();
      const e = await registerBuild(stack, base);
      const u3 = await publish(stack, "u3", variant(base, "u3"));
      const u4 = await publish(stack, "u4", variant(base, "u4"));
      const seen = await patchedLaunch(stack, e, u4, u3.updateId);
      await expect(checkPatch(served(stack), e, u4, seen)).rejects.toThrow(
        `"baseUpdateId":"${u3.updateId}"`,
      );
    });
  });
});

describe("selection", () => {
  test.each([
    [["corrupt-patch"], ["full", "patch-ota", "corrupt-patch"]],
    [["rollback"], ["full", "patch-ota", "corrupt-patch", "rollback"]],
    [
      ["patch-embedded", "embedded"],
      ["embedded", "patch-embedded"],
    ],
    [ALL, ALL],
  ] as const)("%j runs %j", (selected: readonly Scenario[], planned) => {
    expect(plan(selected)).toEqual(planned);
  });

  test("an ota step starts from what the step before left, and does not run after it failed", async () => {
    const calls: [Scenario, string | undefined][] = [];
    const outcomes: [Scenario, Outcome][] = [];
    await runScenarios(
      ALL,
      (name, from) => {
        calls.push([name, from?.updateId]);
        if (name === "patch-ota") return Promise.reject(new Error("answered 200, not 226"));
        const left = { updateId: `after-${name}`, marker: name, hex: "", embedded: false };
        return Promise.resolve({ running: left, saw: `ran ${name}` });
      },
      (name, outcome) => outcomes.push([name, outcome]),
    );
    expect(calls).toEqual([
      ["embedded", undefined],
      ["full", "after-embedded"],
      ["patch-ota", "after-full"],
      ["patch-embedded", undefined],
    ]);
    expect(outcomes).toEqual([
      ["embedded", { pass: true, saw: "ran embedded" }],
      ["full", { pass: true, saw: "ran full" }],
      ["patch-ota", { pass: false, why: "answered 200, not 226" }],
      ["corrupt-patch", { pass: false, why: "not run: patch-ota failed" }],
      ["rollback", { pass: false, why: "not run: patch-ota failed" }],
      ["patch-embedded", { pass: true, saw: "ran patch-embedded" }],
    ]);
  });
});
