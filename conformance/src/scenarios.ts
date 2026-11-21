// What each scenario does on an installed build, and what it requires the app and the recorder to show.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  NO_UPDATE_KEY,
  certificatePublicKey,
  decodeStoredReply,
  diskPath,
  parseMultipart,
  parseSfvDictionary,
  verifyExpoSignature,
} from "@tide/protocol";

import type { AndroidDevice, Report } from "./android.ts";
import type { AndroidBuild, App } from "./app.ts";
import type { Scenario } from "./options.ts";
import type { Stack } from "./stack.ts";

/** One installed build on a device, as the scenarios see it. */
export interface Target {
  readonly stack: Stack;
  readonly device: AndroidDevice;
  readonly app: App;
  readonly build: AndroidBuild;
}

/** The scenarios that exist so far; each returns what it saw, or throws when the client does not behave as it must. */
export const STEPS: Partial<Record<Scenario, (target: Target) => Promise<string>>> = { embedded };

/**
 * Two cold launches each run the embedded update, check, and accept the stored signed no-update reply. The client asks
 * for a signature only when its APK embeds a certificate, and rejects the reply unless that is the run's certificate.
 */
async function embedded({ stack, device, app, build }: Target): Promise<string> {
  for (const launch of ["first", "second"]) {
    device.drain();
    const before = stack.responses.length;
    await device.launch(app.packageName);
    expectReport(launch, await device.nextReport(), {
      event: "running",
      marker: build.marker,
      updateId: build.embeddedUpdateId,
      embedded: true,
    });
    expectReport(launch, await device.nextReport(), {
      event: "check",
      marker: build.marker,
      result: "none",
    });
    await device.forceStop(app.packageName);
    await expectNoUpdate(stack, stack.responses.slice(before), launch);
  }
  return `both launches ran embedded update ${build.embeddedUpdateId} (marker ${build.marker}) and accepted the signed ${NO_UPDATE_KEY}`;
}

/**
 * Throws unless `seen` is one `/manifest` request that expected the run's signature and got the stored no-update
 * reply's exact bytes, a noUpdateAvailable directive that verifies under the run's certificate. Any other body, such
 * as one with no parts, could pass a client's check with nothing to verify.
 */
async function expectNoUpdate(
  stack: Stack,
  seen: Stack["responses"],
  launch: string,
): Promise<void> {
  const fail = (why: string) => {
    const got = seen.map(({ body, ...r }) => ({ ...r, bodyBytes: body?.length }));
    return new Error(`the ${launch} launch's requests ${why}: ${JSON.stringify(got)}`);
  };
  const [only] = seen;
  const keyId =
    only?.expectSignature === undefined
      ? undefined
      : parseSfvDictionary(only.expectSignature, "expo-expect-signature").get("keyid");
  if (seen.length !== 1 || only?.path !== "/manifest" || only.status !== 200) {
    throw fail("were not one /manifest answered with 200");
  }
  if (keyId?.kind !== "string" || keyId.text !== stack.identity.keyId) {
    throw fail("did not expect the run's signature");
  }
  const stored = decodeStoredReply(readFileSync(join(stack.storeDir, diskPath(NO_UPDATE_KEY))));
  const { boundary, body } = only;
  if (
    boundary !== stored.boundary ||
    body === undefined ||
    !Buffer.from(body).equals(stored.body)
  ) {
    throw fail(`were not answered with the bytes of ${NO_UPDATE_KEY}`);
  }
  const key = await certificatePublicKey(readFileSync(stack.identity.certificateFile, "utf8"));
  try {
    const [part, ...rest] = parseMultipart(body, boundary);
    if (part?.name !== "directive" || rest.length > 0 || part.signature === undefined) {
      throw new Error("not one signed directive");
    }
    await verifyExpoSignature(part.body, part.signature, key, stack.identity.keyId);
    if (
      (JSON.parse(new TextDecoder().decode(part.body)) as { type?: unknown }).type !==
      "noUpdateAvailable"
    ) {
      throw new Error("not noUpdateAvailable");
    }
  } catch (e) {
    throw fail(
      `got ${NO_UPDATE_KEY}, which is not a noUpdateAvailable directive signed for the run (${String(e)})`,
    );
  }
}

function expectReport(launch: string, got: Report, want: Report) {
  if (!isDeepStrictEqual({ ...got }, want)) {
    throw new Error(
      `on the ${launch} launch the app reported ${JSON.stringify(got)}, not ${JSON.stringify(want)}`,
    );
  }
}
