import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, onTestFinished, test } from "vitest";

import type { NoUpdateReply } from "@tide-ota/protocol";
import {
  MAX_REPLY_BYTES,
  NO_UPDATE_KEY,
  cryptoKeySigner,
  decodePointer,
  diskPath,
  encodeIdentityNoUpdate,
  encodeMultipart,
  encodeStoredReply,
  expoSignature,
} from "@tide-ota/protocol";

import type { Objects } from "./publish-fixture.ts";
import { startServer, storeFromEnv } from "../../server/src/node.ts";
import { PROBE_EXIT, probe } from "../src/probe.ts";
import { rollback } from "../src/publish-rollback.ts";
import { publish } from "../src/publish.ts";
import { rollout } from "../src/rollout.ts";
import { run, utf8 } from "./helpers.ts";
import {
  IOS,
  MAIN,
  diskObjects,
  env,
  identitiesNoUpdate,
  main,
  other,
  artifact,
  s3,
  s3Env,
  signedManifest,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

const APP_ID = "probe-app";
const cleanup: (() => unknown)[] = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
});

/** A directory removed after the file, for state set up once in `beforeAll`. */
function dir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tide-probe-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Listens on a free loopback port and returns its base URL; the server closes after the file. */
async function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<string> {
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A proxy to `base` that lets `edit` change each request's headers and each reply's before passing them on. */
function proxy(
  base: string,
  edit: { readonly request?: (h: Headers) => void; readonly reply?: (h: Headers) => void },
): Promise<string> {
  return listen(
    createServer((req, res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string" && name !== "host") headers.set(name, value);
      }
      edit.request?.(headers);
      void (async () => {
        const reply = await fetch(`${base}${req.url}`, { headers });
        const body = new Uint8Array(await reply.arrayBuffer());
        const out = new Headers(reply.headers);
        out.delete("content-length");
        edit.reply?.(out);
        res.writeHead(reply.status, Object.fromEntries(out)).end(body);
      })();
    }),
  );
}

/** A server that accepts connections and never answers. */
const silent = () => listen(createTcpServer(() => undefined));

const quiet = { out: () => undefined, err: () => undefined };
const args = (base: string, channel = "main", extra: string[] = [], platform = "ios") => [
  "--server-url",
  base,
  "--channel",
  channel,
  "--runtime-version",
  "1.0.0",
  "--platform",
  platform,
  ...extra,
];
/** The probe's configuration: the builds' certificate and keyid, and nothing else. */
const pins = (certificate = main.certificate, keyId = "main") => ({
  TIDE_BUILD_CERTIFICATE: certificate,
  TIDE_BUILD_KEYID: keyId,
});
const tide = (probeArgs: string[], probeEnv: Record<string, string> = pins()) =>
  run(MAIN, ["probe", ...probeArgs], probeEnv);
const failure = (code: number, message: string) => ({
  code,
  stdout: "",
  stderr: `tide: ${message}\n`,
});

interface Published {
  /** The Tide base URL serving the store. */
  readonly base: string;
  readonly updateId: string;
  readonly hash: string;
  readonly bundleKey: string;
  readonly launchUrl: string;
}

/**
 * Starts the Node server over the store `storeEnv` configures, publishes channel `main` through it, rolls its Android
 * pointer back to embedded and returns the iOS update. Channel `nothing` has no pointer, so it gets `reply/no-update`.
 */
async function publishThrough(
  storeEnv: Record<string, string>,
  objects: () => Objects,
): Promise<Published> {
  const server = await startServer({ port: 0, store: storeFromEnv(storeEnv), appId: APP_ID });
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const write = { ...env(storeEnv), TIDE_SERVER_URL: base };
  expect(
    await publish(["--channel", "main", "--from", artifact({ parent: dir() })], write, quiet),
  ).toBe(0);
  const embedded = ["--embedded", "--channel", "main", "--runtime-version", "1.0.0"];
  expect(await rollback([...embedded, "--platform", "android"], write, quiet)).toBe(0);
  const { manifest } = await signedManifest(objects(), IOS);
  return {
    base,
    updateId: manifest.id,
    hash: manifest.launchAsset.hash,
    bundleKey: new URL(manifest.launchAsset.url).pathname.slice(1),
    launchUrl: manifest.launchAsset.url,
  };
}

interface Store {
  readonly env: Record<string, string>;
  readonly objects: () => Objects;
  readonly published: () => Published;
  /** Replaces the object at `key` for this test, or removes it when `bytes` is undefined. */
  readonly put: (key: string, bytes: Uint8Array | undefined) => void;
}

function diskStore(): Store {
  const root = dir();
  let published: Published;
  beforeAll(async () => {
    published = await publishThrough({ TIDE_DISK_DIR: root }, () => diskObjects(root));
  });
  return {
    env: { TIDE_DISK_DIR: root },
    objects: () => diskObjects(root),
    published: () => published,
    put(key, bytes) {
      const path = join(root, diskPath(key));
      let before: Buffer | undefined;
      try {
        before = readFileSync(path);
      } catch {
        before = undefined;
      }
      onTestFinished(() => {
        if (before === undefined) rmSync(path, { force: true });
        else writeFileSync(path, before);
      });
      if (bytes === undefined) rmSync(path);
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      }
    },
  };
}

function s3Store(): Store {
  let published: Published;
  let snapshot: Map<string, Uint8Array>;
  beforeAll(async () => {
    s3.reset();
    published = await publishThrough(s3Env(), () => s3.objects);
    snapshot = new Map(s3.objects);
  });
  // The fixture empties the fake before each test.
  beforeEach(() => {
    for (const [key, bytes] of snapshot) s3.objects.set(key, bytes);
  });
  return {
    get env() {
      return s3Env();
    },
    objects: () => s3.objects,
    published: () => published,
    put(key, bytes) {
      if (bytes === undefined) s3.objects.delete(key);
      else s3.objects.set(key, bytes);
    },
  };
}

describe.each([
  ["disk", diskStore],
  ["s3", s3Store],
] as const)("tide probe against the Node server on %s", (_, open) => {
  const store = open();

  test("a published update passes: signature, update ID and launch asset hash", async () => {
    const { base, updateId, hash } = store.published();
    expect(await tide(args(base, "main", ["--app-id", APP_ID]))).toEqual({
      code: 0,
      stdout: `manifest ${updateId}: signature verified\nlaunch asset ${hash}: SHA-256 verified\n`,
      stderr: "",
    });
  });

  test("the pinned certificate can be given as a file", async () => {
    const file = join(dir(), "certificate.pem");
    writeFileSync(file, main.certificate);
    const result = await tide(args(store.published().base), {
      TIDE_BUILD_CERTIFICATE_FILE: file,
      TIDE_BUILD_KEYID: "main",
    });
    expect(result.code).toBe(0);
  });

  test.each([
    ["main", "android", "rollBackToEmbedded"],
    ["nothing", "ios", "noUpdateAvailable"],
  ])("%s on %s passes on its signed %s directive alone", async (channel, platform, type) => {
    expect(await tide(args(store.published().base, channel, [], platform))).toEqual({
      code: 0,
      stdout: `directive ${type}: signature verified; a directive has no bundle to check\n`,
      stderr: "",
    });
  });

  test("a certificate other than the publisher's fails the signature", async () => {
    expect(await tide(args(store.published().base), pins(other.certificate))).toEqual(
      failure(
        PROBE_EXIT.signature,
        "the manifest part does not verify under the pinned certificate",
      ),
    );
  });

  test.each([
    ["main", "ios", "manifest"],
    ["main", "android", "directive"],
    ["nothing", "ios", "directive"],
  ])(
    "a keyid other than the publisher's fails the signature of %s on %s",
    async (channel, platform, part) => {
      expect(
        await tide(
          args(store.published().base, channel, [], platform),
          pins(main.certificate, "other"),
        ),
      ).toEqual(
        failure(
          PROBE_EXIT.signature,
          `the ${part} part is signed under another keyid than TIDE_BUILD_KEYID`,
        ),
      );
    },
  );

  test("a launch asset altered after publish fails the hash", async () => {
    const { base, bundleKey } = store.published();
    store.put(bundleKey, utf8("tampered bundle"));
    expect(await tide(args(base))).toEqual(
      failure(PROBE_EXIT.bundleHash, "the launch asset's SHA-256 differs from the manifest's hash"),
    );
  });

  test("a deleted launch asset is missing", async () => {
    const { base, bundleKey } = store.published();
    store.put(bundleKey, undefined);
    expect(await tide(args(base))).toEqual(
      failure(PROBE_EXIT.bundleMissing, "GET launch asset answered 404"),
    );
  });

  test("each pinned keyid is sent, and gets and verifies its own no-update entry", async () => {
    const { base } = store.published();
    store.put("reply/no-update", await identitiesNoUpdate({ main, root: other }));
    const sent: (string | null)[] = [];
    const watched = await proxy(base, {
      request: (h) => {
        sent.push(h.get("expo-expect-signature"));
      },
    });
    const noUpdate = {
      code: 0,
      stdout:
        "directive noUpdateAvailable: signature verified; a directive has no bundle to check\n",
      stderr: "",
    };
    expect(await tide(args(watched, "nothing"))).toEqual(noUpdate);
    expect(await tide(args(watched, "nothing"), pins(other.certificate, "root"))).toEqual(noUpdate);
    expect(sent).toEqual([
      'sig, keyid="main", alg="rsa-v1_5-sha256"',
      'sig, keyid="root", alg="rsa-v1_5-sha256"',
    ]);
  });

  test("a version-3 no-update entry whose multipart body is over MAX_REPLY_BYTES passes", async () => {
    const { base } = store.published();
    const body = utf8(
      JSON.stringify({ type: "noUpdateAvailable", pad: "a".repeat(MAX_REPLY_BYTES) }),
    );
    const signature = await expoSignature(body, cryptoKeySigner(main.keys.privateKey, "main"));
    const reply: NoUpdateReply = {
      kind: "noUpdateAvailable",
      ...encodeMultipart([{ name: "directive", body, signature }]),
    };
    expect(reply.body.length).toBeGreaterThan(MAX_REPLY_BYTES);
    store.put("reply/no-update", encodeIdentityNoUpdate(new Map([["main", reply]])));
    expect(await tide(args(base, "nothing"))).toEqual({
      code: 0,
      stdout:
        "directive noUpdateAvailable: signature verified; a directive has no bundle to check\n",
      stderr: "",
    });
  });

  test("a pointer that is not multipart fails as unparseable", async () => {
    const { base } = store.published();
    store.put(
      "reply/garbage/1.0.0/ios",
      encodeStoredReply({ kind: "rollBackToEmbedded", boundary: "b", body: utf8("not multipart") }),
    );
    expect(await tide(args(base, "garbage"))).toEqual(
      failure(PROBE_EXIT.unparseable, "the reply is not a valid multipart body"),
    );
  });

  test("a reply stripped of expo-protocol-version is unparseable", async () => {
    const base = await proxy(store.published().base, {
      reply: (h) => h.delete("expo-protocol-version"),
    });
    expect(await tide(args(base))).toEqual(
      failure(PROBE_EXIT.unparseable, "the reply's expo-protocol-version is not 1"),
    );
  });

  test("a manifest for another runtime than requested fails before its launch asset", async () => {
    const base = await proxy(store.published().base, {
      // A cache that ignores the runtime header serves another runtime's pointer.
      request: (h) => h.set("expo-runtime-version", "1.0.0"),
    });
    const requested = args(base).map((a) => (a === "1.0.0" ? "2.0.0" : a));
    expect(await tide(requested)).toEqual(
      failure(PROBE_EXIT.mismatch, "the manifest is for another runtime version than requested"),
    );
  });

  test("filters that exclude the signed metadata fail as a client would", async () => {
    const base = await proxy(store.published().base, {
      reply: (h) => h.set("expo-manifest-filters", 'channel="beta"'),
    });
    expect(await tide(args(base))).toEqual(
      failure(PROBE_EXIT.mismatch, "the manifest's metadata does not match expo-manifest-filters"),
    );
  });

  test("a filter on a key the metadata lacks excludes nothing", async () => {
    const base = await proxy(store.published().base, {
      reply: (h) => h.set("expo-manifest-filters", 'channel="main", branch="beta"'),
    });
    expect((await tide(args(base))).code).toBe(0);
  });

  test("filters that are not a dictionary of strings are unparseable", async () => {
    const base = await proxy(store.published().base, {
      reply: (h) => h.set("expo-manifest-filters", "channel=main"),
    });
    expect(await tide(args(base))).toEqual(
      failure(
        PROBE_EXIT.unparseable,
        "the reply's expo-manifest-filters is not a dictionary of strings",
      ),
    );
  });

  test("an app ID the server does not serve is a bad status", async () => {
    expect(await tide(args(store.published().base, "main", ["--app-id", "another-app"]))).toEqual(
      failure(PROBE_EXIT.status, "GET /manifest answered 400"),
    );
  });
});

/** Runs the probe with and without `--json`; fails unless both exit alike with the same stderr. Returns the document. */
async function reported(probeArgs: string[], probeEnv?: Record<string, string>) {
  const text = await tide(probeArgs, probeEnv);
  const json = await tide([...probeArgs, "--json"], probeEnv);
  expect([json.code, json.stderr]).toEqual([text.code, text.stderr]);
  return { code: json.code, stdout: json.stdout };
}
/** A report's exact stdout, its fields in their order and one newline; `fields` replaces those that are null. */
const report = (fields: {
  failure?: keyof typeof PROBE_EXIT;
  rolloutSide?: "new";
  directive?: string;
  updateId?: string;
  launchAssetHash?: string;
}) =>
  `${JSON.stringify({ schema: 1, failure: null, rolloutSide: null, directive: null, updateId: null, launchAssetHash: null, ...fields })}\n`;

describe.each([
  ["disk", diskStore],
  ["s3", s3Store],
] as const)("tide probe --json against the Node server on %s", (_, open) => {
  const store = open();

  test("a manifest reports its update ID and the launch asset hash checked", async () => {
    const { base, updateId, hash } = store.published();
    expect(await reported(args(base))).toEqual({
      code: 0,
      stdout: report({ updateId, launchAssetHash: hash }),
    });
  });

  test.each([
    ["main", "android", "rollBackToEmbedded"],
    ["nothing", "ios", "noUpdateAvailable"],
  ])("%s on %s reports its %s directive", async (channel, platform, directive) => {
    expect(await reported(args(store.published().base, channel, [], platform))).toEqual({
      code: 0,
      stdout: report({ directive }),
    });
  });

  // `mismatch` and `status` are with the rollout probe below.
  test.each<[keyof typeof PROBE_EXIT, () => Promise<string[]> | string[], string?]>([
    [
      "unparseable",
      () => {
        store.put(
          "reply/garbage/1.0.0/ios",
          encodeStoredReply({ kind: "rollBackToEmbedded", boundary: "b", body: utf8("no parts") }),
        );
        return args(store.published().base, "garbage");
      },
    ],
    ["signature", () => args(store.published().base), "another certificate"],
    [
      "bundleMissing",
      () => {
        store.put(store.published().bundleKey, undefined);
        return args(store.published().base);
      },
    ],
    [
      "bundleHash",
      () => {
        store.put(store.published().bundleKey, utf8("tampered bundle"));
        return args(store.published().base);
      },
    ],
    [
      "unreachable",
      async () => {
        const closed = createTcpServer();
        await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
        const { port } = closed.address() as AddressInfo;
        await new Promise((resolve) => closed.close(resolve));
        return args(`http://127.0.0.1:${port}`);
      },
    ],
  ])("a %s failure reports its class and nothing it was served", async (failed, probeArgs, pin) => {
    const probeEnv = pin === undefined ? pins() : pins(other.certificate);
    expect(await reported(await probeArgs(), probeEnv)).toEqual({
      code: PROBE_EXIT[failed],
      stdout: report({ failure: failed }),
    });
  });

  test("a usage error reports nothing", async () => {
    expect(await reported([...args(store.published().base), "--platform", "web"])).toEqual({
      code: PROBE_EXIT.usage,
      stdout: "",
    });
  });
});

/** A rollout bucket, computed here independently of protocol `rolloutBucket`. */
const bucketOf = (updateId: string, clientId: string) =>
  createHash("sha256").update(`${updateId}:${clientId}`).digest().readUInt32BE(0) % 10_000;
const asking = (updateId: string) => ["--rollout-side", "new", "--rollout-update", updateId];

describe.each([
  ["disk", diskStore],
  ["s3", s3Store],
] as const)("tide probe --rollout-side new against the Node server on %s", (_, open) => {
  const store = open();
  const write = () => ({ ...env(store.env), TIDE_SERVER_URL: store.published().base });
  const channelArgs = (channel: string) => ["--channel", channel, "--runtime-version", "1.0.0"];
  const iosKey = (channel: string) => `reply/${channel}/1.0.0/ios`;

  /** Publishes the iOS fixture to `channel` and returns its update ID. */
  async function publishIos(channel: string, extra: string[] = []): Promise<string> {
    const ios = artifact({
      fields: { platforms: { ios: { runtimeVersion: "1.0.0" } } },
      parent: dir(),
    });
    const published = ["--channel", channel, "--from", ios, ...extra];
    expect(await publish(published, write(), quiet)).toBe(0);
    const pointer = decodePointer(store.objects().get(iosKey(channel))!);
    const reply = pointer.kind === "rollout" ? pointer.new : pointer;
    if (reply.kind !== "manifest") throw new Error("not a manifest");
    return reply.updateId;
  }
  const move = async (channel: string, goal: string) => {
    const moved = [goal, ...channelArgs(channel), "--platform", "ios"];
    expect(await rollout(moved, write(), quiet)).toBe(0);
  };
  const probing = (channel: string, updateId: string) =>
    reported(args(store.published().base, channel, asking(updateId)));
  const passing = (updateId: string) => ({
    code: 0,
    stdout: report({
      rolloutSide: "new",
      updateId,
      launchAssetHash: store.published().hash,
    }),
  });
  const MISMATCH = {
    code: PROBE_EXIT.mismatch,
    stdout: report({ failure: "mismatch", rolloutSide: "new" }),
  };

  test("it gets the new side at 0.01% and 100%; without it, 0.01% gets the earlier side", async () => {
    const { base, hash } = store.published();
    const earlier = await publishIos("roll");
    const next = await publishIos("roll", ["--rollout", "0.01"]);
    expect(await probing("roll", next)).toEqual(passing(next));
    expect(await tide(args(base, "roll", asking(next)))).toEqual({
      code: 0,
      stdout: `manifest ${next}: signature verified\nlaunch asset ${hash}: SHA-256 verified\n`,
      stderr: "",
    });
    expect(await reported(args(base, "roll"))).toEqual({
      code: 0,
      stdout: report({ updateId: earlier, launchAssetHash: hash }),
    });
    await move("roll", "complete");
    expect(await probing("roll", next)).toEqual(passing(next));
  });

  test("a rollout reverted to its earlier manifest, rollback or none is a mismatch", async () => {
    const { base } = store.published();
    await publishIos("to-manifest");
    await publishIos("to-rollback");
    const embedded = ["--embedded", ...channelArgs("to-rollback"), "--platform", "ios"];
    expect(await rollback(embedded, write(), quiet)).toBe(0);
    for (const [channel, message] of [
      ["to-manifest", "the server served another update than --rollout-update"],
      ["to-rollback", "the server served a directive, not --rollout-update"],
      ["to-none", "the server served a directive, not --rollout-update"],
    ] as const) {
      const next = await publishIos(channel, ["--rollout", "50"]);
      expect(await probing(channel, next), channel).toEqual(passing(next));
      await move(channel, "revert");
      expect(await probing(channel, next), channel).toEqual(MISMATCH);
      expect(await tide(args(base, channel, asking(next)))).toEqual(failure(9, message));
    }
  });

  test("a rollout replaced by another update is a mismatch, and the update it was replaced by passes", async () => {
    const next = await publishIos("replaced", ["--rollout", "50"]);
    const fix = await publishIos("replaced");
    expect(await probing("replaced", next)).toEqual(MISMATCH);
    // A plain pointer answers as a complete rollout does: every device gets that update.
    expect(await probing("replaced", fix)).toEqual(passing(fix));
  });

  test("no pointer is a mismatch on a signed no-update, and a bad status when there is none", async () => {
    const { updateId } = store.published();
    expect(await probing("nothing", updateId)).toEqual(MISMATCH);
    store.put(NO_UPDATE_KEY, undefined);
    expect(await probing("nothing", updateId)).toEqual({
      code: PROBE_EXIT.status,
      stdout: report({ failure: "status", rolloutSide: "new" }),
    });
  });

  test("the client ID sent is in bucket 0 of the update's rollout, the same each run, and only with the flags", async () => {
    const sent: (string | null)[] = [];
    const watched = await proxy(store.published().base, {
      request: (h) => {
        sent.push(h.get("eas-client-id"));
      },
    });
    const { updateId } = store.published();
    for (const extra of [asking(updateId), asking(updateId), []]) {
      expect((await tide(args(watched, "main", extra))).code).toBe(0);
    }
    const [client] = sent;
    expect(client).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(bucketOf(updateId, client ?? "")).toBe(0);
    expect(sent).toEqual([client, client, null]);
  });
});

describe("tide probe on s3 failures", () => {
  const store = s3Store();

  test("a failing store gives the server's 503 as a bad status, without its body", async () => {
    s3.failAll({ status: 500, code: "InternalError" });
    try {
      expect(await tide(args(store.published().base))).toEqual(
        failure(PROBE_EXIT.status, "GET /manifest answered 503"),
      );
    } finally {
      s3.failAll(undefined);
    }
  });
});

describe("tide probe against other servers", () => {
  test("an unreachable server", async () => {
    const closed = createTcpServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    expect(await tide(args(`http://127.0.0.1:${port}`))).toEqual(
      failure(PROBE_EXIT.unreachable, "GET /manifest failed: the server could not be reached"),
    );
  });

  test("a non-multipart 200 is unparseable, its body unprinted, and the request is a stock client's", async () => {
    let seen: IncomingHttpHeaders = {};
    const base = await listen(
      createServer((req, res) => {
        seen = req.headers;
        res.writeHead(200, { "content-type": "text/html" }).end("<p>secret body</p>");
      }),
    );
    expect(await tide(args(base, "main", ["--app-id", APP_ID]))).toEqual(
      failure(PROBE_EXIT.unparseable, "the reply is not multipart/mixed with a boundary"),
    );
    expect(seen).toMatchObject({
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0.0",
      "expo-channel-name": "main",
      "expo-app-id": APP_ID,
      "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      accept: "multipart/mixed",
    });
    expect(seen["expo-current-update-id"]).toBeUndefined();
  });

  test("a 503 with a body prints only the status", async () => {
    const base = await listen(
      createServer((_req, res) => {
        res.writeHead(503, { "x-detail": "secret header" }).end("secret body");
      }),
    );
    expect(await tide(args(base))).toEqual(
      failure(PROBE_EXIT.status, "GET /manifest answered 503"),
    );
  });

  test("a server that never answers times out", async () => {
    const err: string[] = [];
    const code = await probe(
      args(await silent()),
      pins(),
      { out: () => undefined, err: (l) => err.push(l) },
      { timeoutMs: 200 },
    );
    expect({ code, err }).toEqual({
      code: PROBE_EXIT.unreachable,
      err: ["tide: GET /manifest failed: no reply within 200 ms"],
    });
  });
});

describe("tide probe with a launch asset that never arrives", () => {
  const root = dir();
  let base = "";
  beforeAll(async () => {
    const server = await startServer({ port: 0, store: storeFromEnv({ TIDE_DISK_DIR: root }) });
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The manifest's launch URL names a server that never answers.
    const write = { ...env({ TIDE_DISK_DIR: root }), TIDE_SERVER_URL: await silent() };
    const ios = artifact({
      fields: { platforms: { ios: { runtimeVersion: "1.0.0" } } },
      parent: dir(),
    });
    expect(await publish(["--channel", "main", "--from", ios], write, quiet)).toBe(0);
  });

  test("times out after the signature verifies", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await probe(
      args(base),
      pins(),
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { timeoutMs: 200 },
    );
    expect({ code, out, err }).toEqual({
      code: PROBE_EXIT.unreachable,
      out: [],
      err: ["tide: GET launch asset failed: no reply within 200 ms"],
    });
  });
});

describe("tide probe configuration", () => {
  let requests = 0;
  let base = "";
  beforeAll(async () => {
    base = await listen(
      createServer((_req, res) => {
        requests++;
        res.writeHead(500).end();
      }),
    );
  });
  const at = (channel = "main") => args(base, channel);

  test.each<[string, () => string[], () => Record<string, string>, string]>([
    ["no arguments", () => [], pins, "--server-url, --channel and --runtime-version are required"],
    ["an unknown flag", () => [...at(), "--x"], pins, "unrecognised arguments"],
    ["no platform", () => at().slice(0, -2), pins, "--platform must be ios or android"],
    // localhost is not a loopback IP literal.
    [
      "a plain http URL",
      () => args("http://localhost:1"),
      pins,
      "--server-url must be an https URL",
    ],
    ["a bad channel", () => at("a/b"), pins, "--channel must be 1 to 64 of"],
    ["no keyid", at, () => ({ TIDE_BUILD_CERTIFICATE: "x" }), "TIDE_BUILD_KEYID is not set"],
    [
      "no certificate",
      at,
      () => ({ TIDE_BUILD_KEYID: "main" }),
      "set exactly one of TIDE_BUILD_CERTIFICATE_FILE",
    ],
    [
      "two certificate sources",
      at,
      () => ({ ...pins(), TIDE_BUILD_CERTIFICATE_FILE: "/nonexistent" }),
      "set exactly one of TIDE_BUILD_CERTIFICATE_FILE",
    ],
    [
      "an unreadable certificate file",
      at,
      () => ({ TIDE_BUILD_CERTIFICATE_FILE: "/nonexistent", TIDE_BUILD_KEYID: "main" }),
      "TIDE_BUILD_CERTIFICATE_FILE unreadable",
    ],
    [
      "a certificate that is not PEM",
      at,
      () => pins("not a certificate"),
      "TIDE_BUILD_CERTIFICATE: certificate must be",
    ],
  ])("%s is a usage error before any request", async (_, probeArgs, probeEnv, message) => {
    const err: string[] = [];
    const code = await probe(probeArgs(), probeEnv(), {
      out: () => undefined,
      err: (l) => err.push(l),
    });
    expect(code).toBe(PROBE_EXIT.usage);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(`tide: ${message}`);
    expect(requests).toBe(0);
  });

  const ID = "0f6a9a3e-6c1b-4c4e-9d55-2b8f3f7c1a90";
  const TOGETHER = "--rollout-side and --rollout-update go together";
  test.each<[string, string[], string]>([
    ["no --rollout-update", ["--rollout-side", "new"], TOGETHER],
    ["no --rollout-side", ["--rollout-update", ID], TOGETHER],
    [
      "another side",
      ["--rollout-side", "earlier", "--rollout-update", ID],
      "--rollout-side must be new",
    ],
    ["an uppercase ID", asking(ID.toUpperCase()), "--rollout-update must be a lowercase UUID"],
    ["an ID that is not a UUID", asking("latest"), "--rollout-update must be a lowercase UUID"],
    ["an empty ID", asking(""), "--rollout-update must be a lowercase UUID"],
  ])("the rollout probe with %s is a usage error before any request", async (_, extra, message) => {
    const result = await tide([...at(), ...extra]);
    expect(result).toEqual(failure(PROBE_EXIT.usage, message));
    expect(await tide([...at(), ...extra, "--json"])).toEqual(result);
    expect(requests).toBe(0);
  });

  test("the bin prints the probe usage with no command", async () => {
    const { code, stderr } = await run(MAIN, [], {});
    expect(code).toBe(2);
    expect(stderr).toContain("usage: tide probe --server-url <url>");
  });
});
