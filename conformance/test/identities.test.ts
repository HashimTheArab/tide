// The identity and chain scenarios' steps on fake devices, run by the real drivers, CLI and Tide, and what fails them.
import { X509Certificate, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  NO_UPDATE_KEY,
  certificateChain,
  decodeNoUpdate,
  diskPath,
  encodeIdentityNoUpdate,
  replyKey,
} from "@tide-ota/protocol";

import type { App } from "../src/app.ts";
import type { Builds } from "../src/scenarios.ts";
import type { FakeBuild } from "./fake-app.ts";
import {
  STEPS,
  checkAdded,
  checkNoUpdate,
  checkRotated,
  plan,
  runScenarios,
} from "../src/scenarios.ts";
import { withStack } from "../src/stack.ts";
import { chainAuthority, tideCli } from "../src/tide-cli.ts";
import { fakeBuilds } from "./harness.ts";

const DIRECT = "conformance";
const CHAINED = "conformance-chain";
const CHAIN_STEPS = ["chain-patch", "chain-rollback", "leaf-rotation"] as const;

const pointerKey = (app: App) => replyKey(app.channel, app.runtimeVersion, app.platform);

/** Runs the steps in order and returns each outcome as a line. */
async function outcomes(builds: Builds): Promise<string[]> {
  const lines: string[] = [];
  await runScenarios(
    plan(["leaf-rotation"]),
    (name, from) => STEPS[name].run(builds, from),
    (name, o) => lines.push(`${name}: ${o.pass ? "pass" : o.why.split("\n")[0]}`),
  );
  return lines;
}

/** The outcomes when identities fails with `why`: no chain step runs. */
const failed = (why: unknown) => [
  why,
  ...CHAIN_STEPS.map((name) => `${name}: not run: identities failed`),
];

const withKeyId = (b: FakeBuild, keyid: string): FakeBuild => {
  const { updates } = b.config;
  const codeSigningMetadata = { ...updates.codeSigningMetadata, keyid };
  return { ...b, config: { ...b.config, updates: { ...updates, codeSigningMetadata } } };
};

describe.each(["android", "ios"] as const)("the identity and chain steps on %s", (platform) => {
  test("pass on builds that each send their own keyid, and a rotation fails when the writer keeps its leaf", async () => {
    await withStack(async (stack) => {
      const builds = await fakeBuilds(stack, platform);
      expect(await outcomes(builds)).toEqual(
        ["identities", ...CHAIN_STEPS].map((name) => `${name}: pass`),
      );
      const chained = await builds.chained();
      const kept = { ...chained, rotate: () => Promise.resolve(chained.app.identity) };
      const still = { ...builds, chained: () => Promise.resolve(kept) };
      const from = { updateId: "", marker: "", hex: "", embedded: false };
      await expect(STEPS["leaf-rotation"].run(still, from)).rejects.toThrow(
        "the new leaf's chain is the one already served",
      );
    });
  });

  test.each([
    ["direct", CHAINED, DIRECT],
    ["chained", DIRECT, CHAINED],
  ])("fail when the %s build sends keyid %s", async (_, sent, own) => {
    await withStack(async (stack) => {
      const builds = await fakeBuilds(stack, platform, (b) => withKeyId(b, sent));
      const expected = `sig, keyid="${sent}", alg="rsa-v1_5-sha256"`;
      expect(await outcomes(builds)).toEqual(
        failed(`identities: a /manifest request expected ${expected}, not keyid ${own}`),
      );
    });
  });

  test("fail when the chained build is not opted in, so it refuses the leaf's signature", async () => {
    await withStack(async (stack) => {
      const builds = await fakeBuilds(stack, platform, (b) => ({ ...b, includeChain: false }));
      const refused = /^identities: launch 1: the app reported \{"event":"error".*signature\.sig/;
      expect(await outcomes(builds)).toEqual(failed(expect.stringMatching(refused)));
    });
  });
});

test("the checks fail on each wrong stored or recorded reply", async () => {
  await withStack(async (stack) => {
    const builds = await fakeBuilds(stack, "android");
    const chained = await builds.chained();
    const { app } = chained;
    const stored = (key: string) => join(stack.storeDir, diskPath(key));
    const before = readFileSync(stored(NO_UPDATE_KEY));
    expect(() => checkAdded(builds, chained, before)).toThrow("reply/no-update was not converted");

    const { running: b1 } = await STEPS.identities.run(builds, undefined);
    const after = readFileSync(stored(NO_UPDATE_KEY));
    checkAdded(builds, chained, before);
    expect(() => checkAdded(builds, chained, after)).toThrow(
      "reply/no-update already held one entry per keyid before the publish",
    );
    expect(() => checkAdded(builds, builds, before)).toThrow(
      `reply/no-update holds ${DIRECT}, ${CHAINED}, not ${DIRECT}, ${DIRECT}`,
    );
    const record = decodeNoUpdate(after);
    const entries = record.kind === "identities" ? new Map(record.entries) : undefined;
    const other = entries?.get(CHAINED);
    if (entries === undefined || other === undefined) throw new Error("no chained entry");
    writeFileSync(stored(NO_UPDATE_KEY), encodeIdentityNoUpdate(entries.set(DIRECT, other)));
    expect(() => checkAdded(builds, chained, before)).toThrow(
      `reply/no-update changed the reply of keyid ${DIRECT}`,
    );
    writeFileSync(stored(NO_UPDATE_KEY), after);

    /** Records what the server sends a request for the chained build's update that expects `keyId`. */
    const asking = async (keyId: string) => {
      const headers = {
        "expo-platform": app.platform,
        "expo-channel-name": app.channel,
        "expo-runtime-version": app.runtimeVersion,
        "expo-expect-signature": `sig, keyid="${keyId}", alg="rsa-v1_5-sha256"`,
      };
      await (await fetch(`${stack.serverUrl}/manifest`, { headers })).arrayBuffer();
      return { reports: [], recorded: stack.responses.slice(-1) };
    };
    const { certificateFile } = stack.identity;
    const otherRoot: App = { ...app, identity: { ...app.identity, certificateFile } };
    await expect(
      checkNoUpdate({ stack, app: otherRoot }, b1, await asking(CHAINED)),
    ).rejects.toThrow(
      `got ${pointerKey(app)}, which is not signed for keyid ${CHAINED} (ProtocolError: certificate_chain`,
    );
    await expect(checkNoUpdate(builds, b1, await asking(DIRECT))).rejects.toThrow(
      `a /manifest reply was not the bytes of reply/no-update or ${pointerKey(builds.app)}`,
    );

    const next = await chained.rotate();
    expect(() => checkRotated(chained, next)).toThrow(
      "reply/no-update does not serve the new leaf's chain",
    );
    const { channel, runtimeVersion, platform } = app;
    const pointer = readFileSync(stored(pointerKey(app)));
    // Signs reply/no-update and the pointer afresh.
    await tideCli(stack, next).rollbackToEmbedded({ channel, runtimeVersion, platform });
    checkRotated(chained, next);
    writeFileSync(stored(pointerKey(app)), pointer);
    expect(() => checkRotated(chained, next)).toThrow(
      `${pointerKey(app)} does not serve the new leaf's chain`,
    );
  });
});

test("each leaf has a new key under the intermediate and root the first one has", async () => {
  await withStack(async (stack) => {
    const leaf = await chainAuthority(stack);
    const [first, next] = [await leaf(), await leaf()];
    const pem = (path: string | undefined) => readFileSync(path ?? "", "utf8");
    const root = pem(first.certificateFile);
    expect(next).toMatchObject({ keyId: first.keyId, certificateFile: first.certificateFile });
    expect(pem(next.chainFile).split("-----END")).toHaveLength(3);
    for (const { chainFile, keyFile } of [first, next]) {
      const served = readFileSync(chainFile ?? "");
      await certificateChain(served, root, new Date());
      const key = createPublicKey(pem(keyFile)).export({ type: "spki", format: "der" });
      const leafKey = new X509Certificate(served).publicKey.export({ type: "spki", format: "der" });
      expect(leafKey.equals(key)).toBe(true);
    }
    expect(pem(next.keyFile)).not.toBe(pem(first.keyFile));
  });
});
