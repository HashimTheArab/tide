// The apps the fake devices install and launch. An artifact is an app ID alone, whose launches log the device's app.log,
// or a FakeBuild: App.js over what a stock expo-updates client does with a reply, patches included. It verifies no
// signature; the harness does.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyBsdiff, contentKey, encodeSfvDictionary, parseMultipart } from "@tide-ota/protocol";

import type { Platform } from "../src/options.ts";

export interface FakeBuild {
  readonly appId: string;
  readonly platform: Platform;
  readonly config: {
    readonly runtimeVersion: string;
    readonly updates: {
      readonly url: string;
      readonly requestHeaders: Readonly<Record<string, string>>;
      readonly codeSigningMetadata: { keyid: string; readonly alg: string };
    };
  };
  readonly embedded: FakeUpdate;
}

interface FakeUpdate {
  readonly id: string;
  readonly bundle: string; // Base64.
}

interface Installed extends FakeBuild {
  readonly current?: FakeUpdate; // The downloaded update it runs; absent for the embedded one.
}

/** Installs `artifact` afresh on the fake device at `dir` and returns its app ID. */
export function installApp(dir: string, artifact: string): string {
  const text = readFileSync(artifact, "utf8").trim();
  if (!text.startsWith("{")) return text;
  const { appId } = JSON.parse(text) as FakeBuild;
  writeFileSync(installed(dir, appId), text);
  return appId;
}

/** Launches `appId` on the fake device at `dir`, appending what it logs to `log`. */
export async function launchApp(dir: string, appId: string, log: string): Promise<void> {
  const path = installed(dir, appId);
  if (existsSync(path)) await run(path, (line) => appendFileSync(log, `${line}\n`));
  else appendFileSync(log, readFileSync(join(dir, "app.log"), "utf8"));
}

const installed = (dir: string, appId: string) => join(dir, `${appId}.build.json`);

/** A launch bundle reporting `marker`: 64 KiB that gzip cannot shrink, the same but for the marker. */
export function markedBundle(marker: string): Buffer<ArrayBuffer> {
  const blocks = Array.from({ length: 2048 }, (_, i) =>
    createHash("sha256").update(String(i)).digest(),
  );
  return Buffer.from(Buffer.concat([...blocks, Buffer.from(`MARKER=${marker};`)]));
}

/** Runs the build installed at `path`, logging each report, until it has nothing to reload into. */
async function run(path: string, log: (line: string) => void): Promise<void> {
  for (;;) {
    const app = JSON.parse(readFileSync(path, "utf8")) as Installed;
    const running = app.current ?? app.embedded;
    const bundle = Buffer.from(running.bundle, "base64");
    const marker = /MARKER=([\w-]+);$/.exec(bundle.toString("latin1"))?.[1] ?? "";
    const report = (event: string, fields: object) =>
      log(`tide-conformance ${JSON.stringify({ event, marker, ...fields })}`);
    report("running", { updateId: running.id, embedded: app.current === undefined });
    let next: FakeUpdate | "rollback" | undefined;
    try {
      next = await fetchUpdate(app, running, bundle);
    } catch (e) {
      return report("error", { message: (e as Error).message });
    }
    const rollback = next === "rollback" && app.current !== undefined;
    const current = typeof next === "object" ? next : undefined;
    report("fetched", { isNew: current !== undefined, rollback });
    if (current === undefined && !rollback) return;
    writeFileSync(path, JSON.stringify({ ...app, current }));
  }
}

async function fetchUpdate(
  app: Installed,
  running: FakeUpdate,
  base: Buffer<ArrayBuffer>,
): Promise<FakeUpdate | "rollback" | undefined> {
  const { url, requestHeaders, codeSigningMetadata } = app.config.updates;
  const res = await fetch(url, {
    headers: {
      ...requestHeaders,
      accept: "multipart/mixed,application/expo+json,application/json",
      "expo-protocol-version": "1",
      "expo-platform": app.platform,
      "expo-runtime-version": app.config.runtimeVersion,
      "expo-expect-signature": `sig, ${encodeSfvDictionary({ ...codeSigningMetadata })}`,
      "expo-current-update-id": running.id,
    },
  });
  const boundary = /boundary=(.*)$/.exec(res.headers.get("content-type") ?? "")?.[1];
  if (boundary === undefined) throw new Error(`/manifest answered ${res.status}`);
  const parts = parseMultipart(new Uint8Array(await res.arrayBuffer()), boundary);
  const part = parts.find((p) => p.name === "manifest" || p.name === "directive");
  if (part === undefined) throw new Error("the reply has no manifest or directive");
  const value = JSON.parse(new TextDecoder().decode(part.body)) as {
    type?: string;
    id: string;
    launchAsset: { url: string; hash: string };
  };
  if (part.name === "directive")
    return value.type === "rollBackToEmbedded" ? "rollback" : undefined;
  const reply = await fetch(value.launchAsset.url, {
    headers: {
      "a-im": "bsdiff",
      "expo-current-update-id": running.id,
      "expo-requested-update-id": value.id,
    },
  });
  const bytes = new Uint8Array(await reply.arrayBuffer());
  const bundle = reply.status === 226 ? applyBsdiff(base, bytes, 1 << 20) : bytes;
  const hex = createHash("sha256").update(bundle).digest("hex");
  if (hex !== contentKey(value.launchAsset.hash)) throw new Error("the bundle's hash differs");
  return { id: value.id, bundle: Buffer.from(bundle).toString("base64") };
}
