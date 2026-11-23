// The identity and chain scenarios' steps on fake devices, run by the real drivers, CLI and Tide, and what fails them.
import { X509Certificate, createPublicKey } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { NO_UPDATE_KEY, certificateChain } from "@tide-ota/protocol";

import type { Builds } from "../src/scenarios.ts";
import type { Identity } from "../src/stack.ts";
import { STEPS, checkNoUpdate, launch, plan, runScenarios, storePath } from "../src/scenarios.ts";
import { withStack } from "../src/stack.ts";
import { chainAuthority } from "../src/tide-cli.ts";
import { fakeBuilds } from "./harness.ts";

const CHAIN_STEPS = ["chain-patch", "chain-rollback", "leaf-rotation"] as const;

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

describe.each(["android", "ios"] as const)("the identity and chain steps on %s", (platform) => {
  test("pass on builds that each send their own keyid", async () => {
    await withStack(async (stack) => {
      expect(await outcomes(await fakeBuilds(stack, platform))).toEqual(
        ["identities", ...CHAIN_STEPS].map((name) => `${name}: pass`),
      );
    });
  });
});

test("each version of a run joins its own identities to an emptied bucket", async () => {
  await withStack(async (stack) => {
    for (const version of ["55", "58"] as const) {
      const builds = await fakeBuilds(stack, "android", { version });
      const { saw } = await STEPS.identities.run(builds, undefined);
      expect(saw).toContain("across keyid conformance-chain joining");
    }
  });
});

test("the steps fail when the chained build sends the direct one's keyid", async () => {
  await withStack(async (stack) => {
    const sent = `sig, keyid="conformance", alg="rsa-v1_5-sha256"`;
    expect(await outcomes(await fakeBuilds(stack, "android", { keyid: "conformance" }))).toEqual([
      `identities: a /manifest request expected ${sent}, not keyid conformance-chain`,
      ...CHAIN_STEPS.map((name) => `${name}: not run: identities failed`),
    ]);
  });
});

test("the checks fail on a chained reply under another root or chain, and on an app that reports an error", async () => {
  await withStack(async (stack) => {
    const builds = await fakeBuilds(stack, "android");
    const { running } = await STEPS.identities.run(builds, undefined);
    const chained = await builds.chained();
    const check = async (identity: Identity = chained.app.identity) =>
      checkNoUpdate({ stack, app: { ...chained.app, identity } }, running, [await launch(chained)]);
    await check();
    const { certificateFile } = stack.identity;
    const unsigned = `got ${NO_UPDATE_KEY}, which is not signed for keyid conformance-chain`;
    await expect(check({ ...chained.app.identity, certificateFile })).rejects.toThrow(
      `${unsigned} (ProtocolError: certificate_chain`,
    );
    await expect(check(await chained.rotate())).rejects.toThrow(
      `${unsigned} (Error: its certificate_chain is not the writers')`,
    );
    rmSync(storePath(chained, NO_UPDATE_KEY));
    await expect(check()).rejects.toThrow(`the app reported {"event":"error"`);
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
