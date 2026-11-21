// What each scenario does on an installed build, and what it requires the app and the recorder to show.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { NO_UPDATE_KEY, decodeStoredReply, diskPath, parseSfvDictionary } from "@tide/protocol";

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
  const noUpdate = decodeStoredReply(readFileSync(join(stack.storeDir, diskPath(NO_UPDATE_KEY))));
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
    const seen = stack.responses.slice(before);
    const [only] = seen;
    const answered =
      only?.path === "/manifest" && only.status === 200 && only.boundary === noUpdate.boundary;
    const keyId =
      only?.expectSignature === undefined
        ? undefined
        : parseSfvDictionary(only.expectSignature, "expo-expect-signature").get("keyid");
    const signed = keyId?.kind === "string" && keyId.text === stack.identity.keyId;
    if (seen.length !== 1 || !answered || !signed) {
      throw new Error(
        `the ${launch} launch's requests were not one /manifest expecting the run's signature and answered with ${NO_UPDATE_KEY}: ${JSON.stringify(seen)}`,
      );
    }
  }
  return `both launches ran embedded update ${build.embeddedUpdateId} (marker ${build.marker}) and accepted the signed ${NO_UPDATE_KEY}`;
}

function expectReport(launch: string, got: Report, want: Report) {
  if (!isDeepStrictEqual({ ...got }, want)) {
    throw new Error(
      `on the ${launch} launch the app reported ${JSON.stringify(got)}, not ${JSON.stringify(want)}`,
    );
  }
}
