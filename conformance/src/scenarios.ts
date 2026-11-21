// What each scenario does on an installed build, and what it requires the app and the recorder to show.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { StoredReply } from "@tide/protocol";
import {
  NO_UPDATE_KEY,
  baseKey,
  certificatePublicKey,
  contentKey,
  decodeBaseRecord,
  decodeStoredReply,
  diskPath,
  parseMultipart,
  parseSfvDictionary,
  patchKey,
  replyKey,
  verifyExpoSignature,
} from "@tide/protocol";

import type { AndroidDevice, Report } from "./android.ts";
import type { AndroidBuild, App } from "./app.ts";
import type { Scenario } from "./options.ts";
import type { Recorded, Stack } from "./stack.ts";
import type { TideCli } from "./tide-cli.ts";
import { exportUpdate } from "./app.ts";
import { SCENARIOS } from "./options.ts";
import { tamperPatch } from "./stack.ts";

// A launch that reloads once settles in four reports; more means the app is looping.
const MAX_REPORTS = 8;
const BUNDLE_PATH = /^\/bundles\/([0-9a-f]{64})$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** One version's build on a device, as the scenarios drive it. */
export interface Target {
  readonly stack: Stack;
  readonly device: AndroidDevice;
  readonly cli: TideCli;
  readonly app: App;
  readonly build: AndroidBuild;
}

/** What the checks read: the store and identity, and the channel and runtime the app asks for. */
export type Served = Pick<Target, "stack" | "app">;

/** An update: its ID, the marker its bundle reports, its launch bundle's content key, and whether it is embedded. */
export interface Update {
  readonly updateId: string;
  readonly marker: string;
  readonly hex: string;
  readonly embedded: boolean;
}

/** One launch up to the app's terminal report: what the app reported and what the recorder sent it. */
export interface Trace {
  readonly reports: readonly Report[];
  readonly recorded: readonly Recorded[];
}

interface Step {
  readonly from: "fresh" | "ota"; // Fresh reinstalls the app; ota starts from the update the step before left running.
  run(t: Target, running: Update | undefined): Promise<{ running: Update; saw: string }>;
}

/** What a recorded reply shows, reduced to the fields the expectations name. */
type Exchange =
  | (Pick<Recorded, "path" | "status" | "currentUpdateId"> & { reply: string | undefined })
  | (Pick<
      Recorded,
      "path" | "status" | "aIm" | "currentUpdateId" | "requestedUpdateId" | "im" | "baseUpdateId"
    > & { body: string }) // `bundle`, the store key of the patch it was, `incomplete`, or another digest.
  | Pick<Recorded, "path" | "status">;

interface Launch {
  readonly reports: readonly Report[];
  readonly exchanges: readonly Exchange[];
}

export const STEPS: Record<Scenario, Step> = {
  embedded: {
    from: "fresh",
    async run(t) {
      const e = await install(t);
      await checkEmbedded(t, e, [await launch(t), await launch(t)]);
      return {
        running: e,
        saw: `both launches ran embedded update ${e.updateId} and accepted the signed ${NO_UPDATE_KEY}`,
      };
    },
  },
  full: {
    from: "fresh",
    async run(t) {
      const e = await install(t);
      const u1 = await publish(t, "u1");
      await checkFull(t, e, u1, [await launch(t), await launch(t)]);
      return {
        running: u1,
        saw: `ran ${u1.updateId} from the full bundle; a relaunch got ${NO_UPDATE_KEY}`,
      };
    },
  },
  "patch-ota": {
    from: "ota",
    async run(t, from) {
      const to = await publish(t, "u2");
      await checkPatch(t, ran(from), to, await launch(t));
      return {
        running: to,
        saw: `ran ${to.updateId} from a patch on update ${ran(from).updateId}`,
      };
    },
  },
  "corrupt-patch": {
    from: "ota",
    async run(t, from) {
      const to = await publish(t, "u3");
      const intact = tamperPatch(t.stack.storeDir, ran(from).hex, to.hex);
      await checkCorruptPatch(t, ran(from), to, await launch(t), intact);
      return {
        running: to,
        saw: `ran ${to.updateId} from the full bundle after the tampered patch`,
      };
    },
  },
  rollback: {
    from: "ota",
    async run(t, from) {
      const { channel, runtimeVersion } = t.app;
      await t.cli.rollbackToEmbedded({ channel, runtimeVersion, platform: "android" });
      const e = embedded(t.build);
      await checkRollback(t, ran(from), e, await launch(t));
      return { running: e, saw: `rolled back from ${ran(from).updateId} to ${e.updateId}` };
    },
  },
  "patch-embedded": {
    from: "fresh",
    async run(t) {
      const e = await install(t);
      const { manifest, bundle, resDir } = t.build;
      await t.cli.registerBuild({
        platform: "android",
        runtimeVersion: t.app.runtimeVersion,
        manifest,
        bundle,
        assetsDir: resDir,
      });
      const to = await publish(t, "u4");
      await checkPatch(t, e, to, await launch(t));
      return {
        running: to,
        saw: `ran ${to.updateId} from a patch on embedded update ${e.updateId}`,
      };
    },
  },
};

/**
 * Returns `selected` in run order, adding before each ota step every step back to the fresh step it starts from, so a
 * selected step sees the same trace as in a full run.
 */
export function plan(selected: readonly Scenario[]): Scenario[] {
  const order = Object.keys(SCENARIOS) as Scenario[];
  const keep = new Set<Scenario>();
  for (const name of selected) {
    const at = order.indexOf(name);
    const start = order.findLastIndex((n, i) => i <= at && STEPS[n].from === "fresh");
    for (const n of order.slice(start, at + 1)) keep.add(n);
  }
  return order.filter((name) => keep.has(name));
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Outcome =
  | { readonly pass: true; readonly saw: string }
  | { readonly pass: false; readonly why: string };

/**
 * Runs `names` in order through `run`, reporting each to `done`. An ota step runs only on the update the step before
 * it left; after a failure it reports that it did not run.
 */
export async function runScenarios(
  names: readonly Scenario[],
  run: (name: Scenario, running: Update | undefined) => Promise<{ running: Update; saw: string }>,
  done: (name: Scenario, outcome: Outcome) => void,
): Promise<void> {
  let running: Update | undefined;
  let failed: Scenario | undefined;
  for (const name of names) {
    if (STEPS[name].from === "ota" && running === undefined) {
      done(name, { pass: false, why: `not run: ${failed ?? "no earlier step"} failed` });
      continue;
    }
    try {
      const result = await run(name, running);
      running = result.running;
      done(name, { pass: true, saw: result.saw });
    } catch (e) {
      running = undefined;
      failed = name;
      done(name, { pass: false, why: message(e) });
    }
  }
}

/** Two launches of a fresh install each run the embedded update and accept the signed no-update reply. */
export async function checkEmbedded(s: Served, e: Update, traces: readonly Trace[]): Promise<void> {
  const each = { reports: [running(e), fetched(e, false)], exchanges: [manifest(e, NO_UPDATE)] };
  await compare(s, traces, [each, each], new Map());
}

/**
 * With no base registered for the embedded update and no patch to the first update stored, the client downloads the
 * full bundle and runs it, and a relaunch gets the signed no-update reply.
 */
export async function checkFull(
  s: Served,
  e: Update,
  u1: Update,
  traces: readonly Trace[],
): Promise<void> {
  const into = storedPatches(s).filter((key) => key.endsWith(`/${u1.hex}`));
  if (into.length > 0) throw new Error(`a patch to the first update is stored: ${into.join(", ")}`);
  const base = baseKey(e.updateId);
  if (existsSync(storePath(s, base))) throw new Error(`the embedded update is registered: ${base}`);
  await compare(
    s,
    traces,
    [
      {
        reports: [running(e), fetched(e, true), running(u1), fetched(u1, false)],
        exchanges: [manifest(e, update(u1)), full(e, u1, "bsdiff"), manifest(u1, NO_UPDATE)],
      },
      { reports: [running(u1), fetched(u1, false)], exchanges: [manifest(u1, NO_UPDATE)] },
    ],
    patchLabels(s),
  );
}

/** The client gets the stored patch from the update it runs, as a 226 naming that update, and runs the new update. */
export async function checkPatch(s: Served, from: Update, to: Update, trace: Trace): Promise<void> {
  await compare(
    s,
    [trace],
    [
      {
        reports: [running(from), fetched(from, true), running(to), fetched(to, false)],
        exchanges: [
          manifest(from, update(to)),
          patched(from, to, patchKey(from.hex, to.hex)),
          manifest(to, NO_UPDATE),
        ],
      },
    ],
    patchLabels(s),
  );
}

/**
 * The client gets the tampered patch as a 226, then fetches the full bundle without A-IM and runs the new update.
 * `intact` is the stored patch's SHA-256 before the tamper.
 */
export async function checkCorruptPatch(
  s: Served,
  from: Update,
  to: Update,
  trace: Trace,
  intact: string,
): Promise<void> {
  // Without a fallback the first difference is the next /manifest, so name the missing fetch here.
  const path = `/bundles/${to.hex}`;
  if (!trace.recorded.some((r) => r.path === path && r.status === 200)) {
    const seen = trace.recorded.map((r) => `${r.path} ${r.status}`).join(", ");
    throw new Error(`no fallback: the client never got ${path} answered 200 (saw ${seen})`);
  }
  const key = patchKey(from.hex, to.hex);
  const tampered = sha256File(storePath(s, key));
  if (tampered === intact) throw new Error(`${key} is unchanged since before the tamper`);
  await compare(
    s,
    [trace],
    [
      {
        reports: [running(from), fetched(from, true), running(to), fetched(to, false)],
        exchanges: [
          manifest(from, update(to)),
          patched(from, to, `tampered ${key}`),
          full(from, to, undefined),
          manifest(to, NO_UPDATE),
        ],
      },
    ],
    new Map([
      [intact, key],
      [tampered, `tampered ${key}`],
    ]),
  );
}

/** The client applies the rollback directive, reloads into the embedded update, and then gets the directive again. */
export async function checkRollback(
  s: Served,
  from: Update,
  e: Update,
  trace: Trace,
): Promise<void> {
  await compare(
    s,
    [trace],
    [
      {
        reports: [running(from), fetched(from, false, true), running(e), fetched(e, false)],
        exchanges: [manifest(from, ROLLBACK), manifest(e, ROLLBACK)],
      },
    ],
    new Map(),
  );
}

/** Installs the build afresh and returns its embedded update. */
async function install(t: Target): Promise<Update> {
  await t.device.install(t.build.apk, t.app.packageName);
  return embedded(t.build);
}

const embedded = (build: AndroidBuild): Update => ({
  updateId: build.embeddedUpdateId,
  marker: build.marker,
  hex: sha256File(build.bundle),
  embedded: true,
});

/** Exports the app with a new marker, publishes it to the app's channel and returns the update as stored. */
async function publish(t: Target, name: string): Promise<Update> {
  const marker = `${name}-${t.app.version}-${randomUUID().slice(0, 8)}`;
  const from = await exportUpdate(t.stack, t.cli, t.app, marker);
  const { android: updateId } = await t.cli.publish(from, t.app.channel);
  if (updateId === undefined)
    throw new Error(`tide publish wrote no android pointer for ${marker}`);
  const base = decodeBaseRecord(readFileSync(storePath(t, baseKey(updateId))));
  return { updateId, marker, hex: contentKey(base.launchAsset.hash), embedded: false };
}

/**
 * Launches the app and reads its reports until it settles, then stops it, so it neither reloads nor requests after
 * the step; returns what it reported and the replies recorded meanwhile.
 */
async function launch(t: Target): Promise<Trace> {
  t.device.drain();
  const before = t.stack.responses.length;
  const reports: Report[] = [];
  try {
    await t.device.launch(t.app.packageName);
    while (!settled(reports.at(-1))) {
      if (reports.length === MAX_REPORTS) throw new Error(`no settled report in ${MAX_REPORTS}`);
      reports.push(await t.device.nextReport());
    }
  } catch (e) {
    throw new Error(`${message(e)}; the app reported ${JSON.stringify(reports)}`);
  } finally {
    await t.device.forceStop(t.app.packageName);
  }
  return { reports, recorded: t.stack.responses.slice(before) };
}

/** Whether `r` ends a launch: an error, or a fetch that leaves nothing to reload into. */
const settled = (r: Report | undefined) =>
  r !== undefined && (r.event === "error" || (r.event === "fetched" && !r.isNew && !r.rollback));

const ran = (from: Update | undefined): Update => {
  if (from === undefined) throw new Error("no update is running");
  return from;
};

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

const NO_UPDATE = "noUpdateAvailable";
const ROLLBACK = "rollBackToEmbedded";
const update = (u: Update) => `update ${u.updateId}`;

const manifest = (current: Update, reply: string): Exchange => ({
  path: "/manifest",
  status: 200,
  currentUpdateId: current.updateId,
  reply,
});

/** A full-bundle reply for `to` to a client running `from` that sent `aIm`. */
const full = (from: Update, to: Update, aIm: string | undefined): Exchange => ({
  path: `/bundles/${to.hex}`,
  status: 200,
  aIm,
  currentUpdateId: from.updateId,
  requestedUpdateId: to.updateId,
  im: undefined,
  baseUpdateId: undefined,
  body: "bundle",
});

/** A 226 for `to` patched from `from`, whose body is the one `body` labels. */
const patched = (from: Update, to: Update, body: string): Exchange => ({
  path: `/bundles/${to.hex}`,
  status: 226,
  aIm: "bsdiff",
  currentUpdateId: from.updateId,
  requestedUpdateId: to.updateId,
  im: "bsdiff",
  baseUpdateId: from.updateId,
  body,
});

/**
 * Throws unless each trace shows exactly the launch `want` names; the message names the first difference. `labels`
 * names bundle bodies by SHA-256.
 */
async function compare(
  s: Served,
  traces: readonly Trace[],
  want: readonly Launch[],
  labels: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [i, w] of want.entries()) {
    const trace = traces[i] ?? { reports: [], recorded: [] };
    const got: Launch = {
      reports: trace.reports.map((r) => ({ ...r })),
      exchanges: await Promise.all(trace.recorded.map((r) => exchange(s, r, labels))),
    };
    if (isDeepStrictEqual(got, w)) continue;
    const at = want.length > 1 ? `launch ${i + 1}: ` : "";
    throw new Error(
      `${at}${difference(got, w)}\n  got ${JSON.stringify(got)}\n  want ${JSON.stringify(w)}`,
    );
  }
}

function difference(got: Launch, want: Launch): string {
  const json = (v: unknown) => (v === undefined ? "nothing" : JSON.stringify(v));
  for (let i = 0; i < Math.max(got.reports.length, want.reports.length); i++) {
    if (!isDeepStrictEqual(got.reports[i], want.reports[i])) {
      return `the app reported ${json(got.reports[i])}, not ${json(want.reports[i])}`;
    }
  }
  for (let i = 0; i < Math.max(got.exchanges.length, want.exchanges.length); i++) {
    const [g, w] = [got.exchanges[i], want.exchanges[i]];
    if (isDeepStrictEqual(g, w)) continue;
    if (g === undefined) return `the client never requested ${w?.path}`;
    if (w === undefined) return `the client also requested ${g.path}, answered ${g.status}`;
    if (g.path === w.path && g.status !== w.status) {
      return `${g.path} answered ${g.status}, not ${w.status}`;
    }
    return `${g.path} was ${json(g)}, not ${json(w)}`;
  }
  return "the launch differs";
}

async function exchange(
  s: Served,
  r: Recorded,
  labels: ReadonlyMap<string, string>,
): Promise<Exchange> {
  const { path, status, aIm, currentUpdateId, requestedUpdateId, im, baseUpdateId, sha256 } = r;
  if (path === "/manifest") {
    const reply = status === 200 ? await verifyReply(s, r) : undefined;
    return { path, status, currentUpdateId, reply };
  }
  const hex = BUNDLE_PATH.exec(path)?.[1];
  if (hex === undefined) return { path, status };
  return {
    path,
    status,
    aIm,
    currentUpdateId,
    requestedUpdateId,
    im,
    baseUpdateId,
    body:
      sha256 === undefined
        ? "incomplete"
        : sha256 === hex
          ? "bundle"
          : (labels.get(sha256) ?? sha256),
  };
}

/**
 * Returns the label of a `/manifest` reply: `update <id>` or the directive's type. Throws unless the request expected
 * the run's signature and the reply is the exact bytes of the stored no-update reply or of the app's pointer, whose
 * one signed part verifies under the run's certificate. Any other body, such as one with no parts, could pass a
 * client's check with nothing to verify.
 */
async function verifyReply(s: Served, r: Recorded): Promise<string> {
  const { identity } = s.stack;
  const keyId =
    r.expectSignature === undefined
      ? undefined
      : parseSfvDictionary(r.expectSignature, "expo-expect-signature").get("keyid");
  if (keyId?.kind !== "string" || keyId.text !== identity.keyId) {
    throw new Error(`a /manifest request did not expect the run's signature`);
  }
  const pointer = replyKey(s.app.channel, s.app.runtimeVersion, "android");
  const { boundary, body } = r;
  const key = [NO_UPDATE_KEY, pointer].find((k) => {
    const stored = storedReply(s, k);
    if (stored === undefined || body === undefined) return false;
    return stored.boundary === boundary && Buffer.from(stored.body).equals(body);
  });
  if (key === undefined || boundary === undefined || body === undefined) {
    throw new Error(`a /manifest reply was not the bytes of ${NO_UPDATE_KEY} or ${pointer}`);
  }
  try {
    const signed = parseMultipart(body, boundary).filter(
      (p) => p.name === "manifest" || p.name === "directive",
    );
    const [part] = signed;
    if (part?.signature === undefined || signed.length > 1) {
      throw new Error("not one signed manifest or directive");
    }
    const cert = await certificatePublicKey(readFileSync(identity.certificateFile, "utf8"));
    await verifyExpoSignature(part.body, part.signature, cert, identity.keyId);
    const value = JSON.parse(utf8.decode(part.body)) as { id?: unknown; type?: unknown };
    return part.name === "manifest" ? `update ${String(value.id)}` : String(value.type);
  } catch (e) {
    throw new Error(`got ${key}, which is not signed for the run (${String(e)})`);
  }
}

function storedReply(s: Served, key: string): StoredReply | undefined {
  const path = storePath(s, key);
  return existsSync(path) ? decodeStoredReply(readFileSync(path)) : undefined;
}

/** Every stored patch's key. */
function storedPatches(s: Served): string[] {
  const root = join(s.stack.storeDir, "patches");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((from) =>
    readdirSync(join(root, from)).map((to) => patchKey(from, to)),
  );
}

/** Names each stored patch's SHA-256 by its key. */
const patchLabels = (s: Served) =>
  new Map(storedPatches(s).map((key) => [sha256File(storePath(s, key)), key]));

const storePath = (s: Pick<Served, "stack">, key: string) => join(s.stack.storeDir, diskPath(key));

const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
