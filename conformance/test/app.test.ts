import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { materialise, writeMarker } from "../src/app.ts";
import { EXPO_VERSIONS, PLATFORMS } from "../src/options.ts";
import { withStack } from "../src/stack.ts";

const APPS = fileURLToPath(new URL("../apps/", import.meta.url));
const VERSIONS = Object.keys(EXPO_VERSIONS) as (keyof typeof EXPO_VERSIONS)[];
const bytes = (path: string) => readFileSync(path).toString("base64");

describe("the conformance app", () => {
  test.each(VERSIONS.flatMap((v) => PLATFORMS.map((p) => [v, p] as const)))(
    "materialise copies the %s app for %s and configures it for the stack's Tide and identity",
    async (version, platform) => {
      await withStack((stack) => {
        const app = materialise(stack, version, platform);
        expect(app).toEqual({
          version,
          platform,
          identity: stack.identity,
          dir: join(stack.dir, `app-${version}`),
          appId: `dev.tide.conformance.sdk${version}`,
          channel: `expo-${version}`,
          runtimeVersion: `1.0.0-sdk${version}`,
        });
        const { expo } = JSON.parse(readFileSync(join(app.dir, "app.json"), "utf8")) as {
          expo: Record<string, unknown>;
        };
        expect(expo).toMatchObject({
          runtimeVersion: `1.0.0-sdk${version}`,
          android: { package: app.appId },
          ios: { bundleIdentifier: app.appId },
          plugins: ["./cleartext.js"],
        });
        expect(expo.updates).toEqual({
          url: `${stack.serverUrl}/manifest`,
          requestHeaders: { "expo-channel-name": app.channel },
          checkAutomatically: "NEVER",
          enableBsdiffPatchSupport: true,
          codeSigningCertificate: "./keys/certificate.pem",
          codeSigningMetadata: { keyid: stack.identity.keyId, alg: "rsa-v1_5-sha256" },
        });
        expect(bytes(join(app.dir, "keys", "certificate.pem"))).toBe(
          bytes(stack.identity.certificateFile),
        );
        for (const file of readdirSync(join(APPS, "shared"))) {
          expect(bytes(join(app.dir, file))).toBe(bytes(join(APPS, "shared", file)));
        }
        for (const file of ["package.json", "package-lock.json"]) {
          expect(bytes(join(app.dir, file))).toBe(bytes(join(APPS, `sdk-${version}`, file)));
        }
        writeMarker(app, 'u1 "quoted"');
        expect(readFileSync(join(app.dir, "marker.js"), "utf8")).toBe(
          'export const MARKER = "u1 \\"quoted\\"";\n',
        );
        return Promise.resolve();
      });
    },
  );

  test.each(VERSIONS)(
    "a chain-mode identity gives the %s app its own ID and runtime on the same channel, and the native opt-in",
    async (version) => {
      await withStack((stack) => {
        const identity = { ...stack.identity, keyId: "chain", chainFile: "chain.pem" };
        const direct = materialise(stack, version, "android");
        const app = materialise(stack, version, "android", identity);
        expect(app).toEqual({
          ...direct,
          identity,
          dir: `${direct.dir}-chained`,
          appId: `${direct.appId}.chained`,
          runtimeVersion: `${direct.runtimeVersion}-chained`,
        });
        const { expo } = JSON.parse(readFileSync(join(app.dir, "app.json"), "utf8")) as {
          expo: { plugins: string[]; updates: Record<string, unknown> };
        };
        expect(expo.plugins).toEqual(["./cleartext.js", "./certificate-chain.js"]);
        expect(expo.updates).toMatchObject({
          codeSigningMetadata: { keyid: "chain" },
          codeSigningIncludeManifestResponseCertificateChain: true,
        });
        return Promise.resolve();
      });
    },
  );

  test.each(VERSIONS)(
    "the %s app locks expo and expo-updates on its line, at or above the embedded-patch minimum",
    (version) => {
      const lock = JSON.parse(
        readFileSync(join(APPS, `sdk-${version}`, "package-lock.json"), "utf8"),
      ) as { packages: Record<string, { version: string }> };
      const minimum = /from (\d+)\.(\d+)\.(\d+)/.exec(EXPO_VERSIONS[version])?.slice(1).map(Number);
      for (const name of ["expo", "expo-updates"]) {
        const locked = lock.packages[`node_modules/${name}`]?.version.split(".").map(Number) ?? [];
        expect(locked[0]).toBe(Number(version));
        if (name === "expo-updates") {
          expect(locked[1] ?? 0).toBe(minimum?.[1]);
          expect(locked[2] ?? 0).toBeGreaterThanOrEqual(minimum?.[2] ?? Infinity);
        }
      }
    },
  );
});
