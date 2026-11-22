import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import { applyBsdiff, contentKey, patchKey, sha256Base64Url } from "@tide-ota/protocol";

import type { Issued } from "./chain-fixture.ts";
import { EXPORT_USAGE } from "../src/export.ts";
import { generate, root as issueRoot } from "./chain-fixture.ts";
import { FAKE_VERSION, fakeHbc } from "./fake-hermesc.ts";
import { expectNoPem, run, tempRoot, utf8 } from "./helpers.ts";
import {
  MAIN,
  PNG_MD5,
  artifact,
  diskObjects,
  env,
  exportIn,
  installFakeExpo,
  installFakeHermes,
  main,
  project,
  tree,
  useFixture,
} from "./publish-fixture.ts";

useFixture();

const SENTINEL = "sentinel-7f3c9a";
const FONT_MD5 = "75d117bbd0d2fe64c29bb45b5abe285e";
const DOM = "www.bundle/f64cfef467216a023648b79c60d829a3.html";
const PATH = { PATH: process.env.PATH ?? "" };

/** Every file under `dir`, relative to it. */
const files = (dir: string) => [...tree(dir).keys()].sort();

describe("the export directory", () => {
  test("holds the public config, runtimes, certificate and keyid, and only the files metadata.json names", async () => {
    const app = project({
      overrides: {
        ios: { bundleIdentifier: "com.example.fixture", config: { googleMapsApiKey: SENTINEL } },
        hooks: { postPublish: [{ file: "notify", config: { token: SENTINEL } }] },
        _internal: { projectRoot: SENTINEL },
        updates: {
          url: "https://updates.example.com/manifest",
          codeSigningCertificate: "./keys/certificate.pem",
          codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256", secret: SENTINEL },
        },
      },
    });
    mkdirSync(join(app.root, "public"));
    writeFileSync(join(app.root, "public", "private.txt"), SENTINEL);

    // No signing key, bucket credential or build pin: export needs none.
    const result = await exportIn(app.root, ["--platform", "ios"], PATH);
    expect(result).toMatchObject({ code: 0, out: ["ios 1.0.0"], err: [] });
    expect(files(result.dir)).toEqual(
      [
        "tide-export.json",
        "dist/metadata.json",
        "dist/_expo/static/js/ios/index-ios.hbc",
        `dist/assets/${PNG_MD5}`,
        `dist/assets/${FONT_MD5}`,
        `dist/${DOM}`,
      ].sort(),
    );
    for (const [path, base64] of tree(result.dir)) {
      expect([path, Buffer.from(base64, "base64").includes(SENTINEL)]).toEqual([path, false]);
    }
    const exported = JSON.parse(
      readFileSync(join(result.dir, "tide-export.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(exported)).toEqual([
      "version",
      "certificate",
      "codeSigningMetadata",
      "expoClient",
      "platforms",
    ]);
    expect(exported.version).toBe(1);
    expect(exported.certificate).toBe(main.certificate);
    expect(exported.codeSigningMetadata).toEqual({ keyid: "main", alg: "rsa-v1_5-sha256" });
    expect(exported.platforms).toEqual({ ios: { runtimeVersion: "1.0.0" } });
    expect(exported.expoClient).toEqual({
      name: "Fixture",
      slug: "fixture",
      version: "1.0.0",
      runtimeVersion: "1.0.0",
      extra: { mode: "production" },
      updates: { url: "https://updates.example.com/manifest" },
      ios: { bundleIdentifier: "com.example.fixture" },
    });
    // The exported bytes are Expo's own.
    expect(readFileSync(join(result.dir, "dist", DOM))).toEqual(
      readFileSync(new URL(`fixtures/export/${DOM}`, import.meta.url)),
    );
  });

  test("a relative --out resolves against the caller's directory, and Expo gets it absolute", async () => {
    // A workspace: the tools are installed at its root, two levels above the app.
    const workspace = tempRoot();
    installFakeExpo(workspace);
    const app = project({ root: join(workspace, "apps", "app") });
    const cwd = tempRoot();
    const result = await run(
      MAIN,
      ["export", "--project-root", app.root, "--out", "out", "--platform", "android"],
      PATH,
      cwd,
    );
    expect(result.stdout).toBe("android 1.0.0\n");
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, "out", "tide-export.json"))).toBe(true);
    expect(existsSync(join(app.root, "out"))).toBe(false);
    const exported = app.log().find((l) => l.args[0] === "export");
    const outputDir = exported?.args[exported.args.indexOf("--output-dir") + 1] ?? "";
    expect(outputDir.startsWith("/")).toBe(true);
    expect(relative(cwd, outputDir).startsWith("..")).toBe(true); // Staged elsewhere, never in --out.
    expect(exported?.args.slice(3)).toEqual(["--platform", "android"]);
  });
});

describe("child processes", () => {
  test("every Expo tool sees only the allowlisted environment, in production mode", async () => {
    const app = project();
    const secrets = {
      TIDE_SIGNING_KEY: "x",
      TIDE_S3_ENDPOINT: "x",
      TIDE_S3_REGION: "x",
      TIDE_S3_BUCKET: "x",
      TIDE_S3_ACCESS_KEY_ID: "x",
      TIDE_S3_SECRET_ACCESS_KEY: "x",
      TIDE_KMS_KEY_ID: "x",
      TIDE_KMS_ACCESS_KEY_ID: "x",
      TIDE_KMS_SECRET_ACCESS_KEY: "x",
      TIDE_KMS_SESSION_TOKEN: "x",
      AWS_ACCESS_KEY_ID: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      AWS_SESSION_TOKEN: "x",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
      ACTIONS_ID_TOKEN_REQUEST_URL: "x",
      OTHER: "x",
    };
    const passed = {
      ...PATH,
      LANG: "C",
      EXPO_PUBLIC_API: "https://api.example.com",
      APP_VARIANT: "beta",
    };
    const result = await exportIn(app.root, ["--pass-env", "APP_VARIANT"], {
      ...secrets,
      ...passed,
    });
    expect(result).toMatchObject({ code: 0, err: [] });
    const log = app.log();
    expect(log.map((l) => [l.tool, l.args[0]])).toEqual([
      ["expo", "config"],
      ["expo", "config"],
      ["expo-updates", "runtimeversion:resolve"],
      ["expo-updates", "runtimeversion:resolve"],
      ["expo", "export"],
    ]);
    // What /bin/sh adds running the shim, and macOS to every process.
    const SHELL = new Set(["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"]);
    for (const { env: seen } of log) {
      const own = Object.fromEntries(Object.entries(seen).filter(([k]) => !SHELL.has(k)));
      expect(own).toEqual({
        ...passed,
        EXPO_NO_DOTENV: "1",
        NODE_ENV: "production",
        BABEL_ENV: "production",
      });
    }
  });

  test.each(["", "staging"])("BABEL_ENV %j reaches every Expo tool alike", async (babel) => {
    const app = project();
    const result = await exportIn(app.root, [], { ...PATH, BABEL_ENV: babel });
    expect(result.code).toBe(0);
    const expected = babel === "" ? "production" : babel;
    expect(new Set(app.log().map((l) => l.env.BABEL_ENV))).toEqual(new Set([expected]));
    // Config, runtime and bundle agree on one branch of the app config.
    const exported = JSON.parse(readFileSync(join(result.dir, "tide-export.json"), "utf8")) as {
      expoClient: { extra: unknown };
      platforms: unknown;
    };
    const runtime = babel === "" ? "1.0.0" : "dev";
    expect(exported.platforms).toEqual({
      ios: { runtimeVersion: runtime },
      android: { runtimeVersion: runtime },
    });
    expect(exported.expoClient.extra).toEqual({
      mode: babel === "" ? "production" : "development",
    });
  });

  test("each platform's runtime version is its own, and --runtime-version overrides both without the resolver", async () => {
    const app = project({
      overrides: { ios: { runtimeVersion: "2.0.0" }, android: { runtimeVersion: "3.0.0(1)" } },
    });
    expect((await exportIn(app.root)).out).toEqual(["ios 2.0.0", "android 3.0.0(1)"]);
    const given = project();
    expect((await exportIn(given.root, ["--runtime-version", "9.9.9"])).out).toEqual([
      "ios 9.9.9",
      "android 9.9.9",
    ]);
    expect(given.log().filter((l) => l.tool === "expo-updates")).toEqual([]);
  });

  test.each(["TIDE_SIGNING_KEY", "AWS_PROFILE", "ACTIONS_RUNTIME_TOKEN", "aws_secret", "1BAD"])(
    "--pass-env %s is refused before any Expo tool runs",
    async (name) => {
      const app = project();
      const result = await exportIn(app.root, ["--pass-env", name], PATH);
      expect(result.code).toBe(2);
      expect(result.err).toEqual([
        /^[A-Za-z_]/.test(name)
          ? "tide: --pass-env cannot pass TIDE_, AWS_ or ACTIONS_ variables to project code"
          : "tide: --pass-env must name an environment variable",
      ]);
      expect(readdirSync(app.root)).not.toContain("fake-expo.log");
      expect(existsSync(result.dir)).toBe(false);
    },
  );
});

test("no writer starts a child process, even from inside a project with Expo installed", async () => {
  // Every command a writer could reach on PATH leaves a marker instead.
  const shims = tempRoot();
  const marker = join(shims, "marker");
  for (const name of ["node", "sh", "npx", "npm", "pnpm", "expo", "expo-updates", "git"]) {
    writeFileSync(join(shims, name), `#!/bin/sh\necho ${name} >> '${marker}'\n`);
    chmodSync(join(shims, name), 0o755);
  }
  const app = project();
  const bucket = tempRoot();
  const environment = { ...env({ TIDE_DISK_DIR: bucket }), PATH: shims };
  const tide = async (...args: string[]) => {
    const result = await run(MAIN, args, environment, app.root);
    expect([args[0], result.code, result.stderr]).toEqual([args[0], 0, ""]);
    return result.stdout;
  };
  const published = await tide("publish", "--from", artifact(), "--channel", "main");
  const id = published.split(" ")[1] ?? "";
  await tide("republish", id, "--channel", "beta");
  await tide("rollback", "--to", id);
  await tide("rollback", "--embedded", "--channel", "main", "--runtime-version", "1.0.0");
  const build = tempRoot();
  writeFileSync(join(build, "app.manifest"), JSON.stringify({ id: randomUUID(), assets: [] }));
  writeFileSync(join(build, "main.jsbundle"), "embedded");
  await tide(
    ...["register-build", "--platform", "ios", "--runtime-version", "1.0.0"],
    ...["--manifest", join(build, "app.manifest"), "--bundle", join(build, "main.jsbundle")],
  );
  expect(existsSync(marker)).toBe(false);
  expect(readdirSync(app.root)).not.toContain("fake-expo.log");
});

describe("chain mode", () => {
  const FLAG = "codeSigningIncludeManifestResponseCertificateChain";
  let root: Issued;
  beforeAll(async () => {
    root = await issueRoot(await generate());
  });
  const updates = (flag: unknown) => ({
    updates: {
      url: "https://updates.example.com/manifest",
      codeSigningCertificate: "./keys/certificate.pem",
      codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      ...(flag !== undefined && { [FLAG]: flag }),
    },
  });
  const exported = (dir: string) => readFileSync(join(dir, "tide-export.json"), "utf8");

  test("an app that includes the certificate chain records chain mode after its metadata, with the root", async () => {
    const app = project({ cert: root.certificate, overrides: updates(true) });
    const result = await exportIn(app.root, ["--platform", "ios"], PATH);
    expect(result).toMatchObject({ code: 0, err: [] });
    const text = exported(result.dir);
    expect(text).toContain(
      `"codeSigningMetadata":{"keyid":"main","alg":"rsa-v1_5-sha256"},"${FLAG}":true,"expoClient":`,
    );
    expect((JSON.parse(text) as { certificate: string }).certificate).toBe(root.certificate);
  });

  test.each([undefined, false])(
    "with the flag %s the export holds no chain member, in the fields and order of a direct export",
    async (flag) => {
      const app = project({ overrides: updates(flag) });
      const result = await exportIn(app.root, ["--platform", "ios"], PATH);
      expect(result).toMatchObject({ code: 0, err: [] });
      const text = exported(result.dir);
      const { version, certificate, codeSigningMetadata, expoClient, platforms } = JSON.parse(
        text,
      ) as Record<string, unknown>;
      const direct = { version, certificate, codeSigningMetadata, expoClient, platforms };
      expect(text).toBe(JSON.stringify(direct));
    },
  );

  test.each<[string, () => { overrides: object; cert?: string }, string]>([
    [
      "a flag that is not a boolean",
      () => ({ cert: root.certificate, overrides: updates("true") }),
      `app config updates.${FLAG} must be true or false`,
    ],
    [
      "a direct-signing certificate with the flag",
      () => ({ overrides: updates(true) }),
      "updates.codeSigningCertificate: root must be a CA with Key Usage keyCertSign",
    ],
    [
      "a CA root without the flag",
      () => ({ cert: root.certificate, overrides: updates(undefined) }),
      "updates.codeSigningCertificate: certificate must have Key Usage digitalSignature",
    ],
  ])("%s is refused before --out is created", async (_, given, message) => {
    const result = await exportIn(project(given()).root, [], PATH);
    expect(result).toMatchObject({ code: 2, out: [], err: [`tide: ${message}`] });
    expect(existsSync(result.dir)).toBe(false);
  });
});

describe("refusals", () => {
  const updates = (metadata: unknown, certificate?: string) => ({
    updates: {
      url: "https://updates.example.com/manifest",
      codeSigningCertificate: certificate,
      codeSigningMetadata: metadata,
    },
  });

  test.each<[string, () => { overrides?: object; cert?: string }, string]>([
    [
      "no certificate",
      () => ({ overrides: updates({ keyid: "main" }) }),
      "app config has no updates.codeSigningCertificate: Tide publishes only signed updates",
    ],
    [
      "a private key as the certificate",
      () => ({ cert: main.pkcs8 }),
      "updates.codeSigningCertificate: certificate must be exactly one PEM CERTIFICATE block",
    ],
    [
      "a certificate followed by its key",
      () => ({ cert: `${main.certificate}\n${main.pkcs8}` }),
      "updates.codeSigningCertificate: certificate must be exactly one PEM CERTIFICATE block",
    ],
    [
      "no keyid",
      () => ({ overrides: updates({ alg: "rsa-v1_5-sha256" }, "./keys/certificate.pem") }),
      "app config updates.codeSigningMetadata.keyid is missing",
    ],
    [
      "an object keyid",
      () => ({ overrides: updates({ keyid: { nested: SENTINEL } }, "./keys/certificate.pem") }),
      "app config updates.codeSigningMetadata.keyid must be non-empty printable ASCII",
    ],
    [
      "an object alg",
      () => ({
        overrides: updates({ keyid: "main", alg: { nested: SENTINEL } }, "./keys/certificate.pem"),
      }),
      "app config updates.codeSigningMetadata.alg must be rsa-v1_5-sha256",
    ],
    [
      "another alg",
      () => ({ overrides: updates({ keyid: "main", alg: "ecdsa" }, "./keys/certificate.pem") }),
      "app config updates.codeSigningMetadata.alg must be rsa-v1_5-sha256",
    ],
    [
      "no runtime version",
      () => ({ overrides: { runtimeVersion: null } }),
      "no ios runtime version: set runtimeVersion or pass --runtime-version",
    ],
    [
      "a resolved runtime version outside the key grammar",
      () => ({ overrides: { runtimeVersion: "1.0/2" } }),
      "runtimeVersion must be 1 to 64 of A-Z, a-z, 0-9, ., _, +, -, (, ) and :, and not . or ..",
    ],
  ])("%s is refused before --out is created", async (_, given, message) => {
    const app = project(given());
    const result = await exportIn(app.root, [], PATH);
    expect(result).toMatchObject({ code: 2, out: [], err: [`tide: ${message}`] });
    expectNoPem(result.err.join("\n"), main.pkcs8);
    expect(result.err.join("\n")).not.toContain(SENTINEL);
    expect(existsSync(result.dir)).toBe(false);
  });

  test("a missing certificate file is refused", async () => {
    const app = project();
    rmSync(join(app.root, "keys", "certificate.pem"));
    expect(await exportIn(app.root, [], PATH)).toMatchObject({
      code: 2,
      err: ["tide: updates.codeSigningCertificate is unreadable or over 64 KiB"],
    });
  });

  test("a project without Expo installed is refused", async () => {
    const app = project({ root: join(tempRoot(), "app") });
    expect(await exportIn(app.root, [], PATH)).toMatchObject({
      code: 2,
      err: [
        "tide: expo is not installed in the project: add expo and expo-updates to its dependencies",
      ],
    });
  });

  test("an Expo tool that fails refuses the export", async () => {
    const app = project();
    writeFileSync(join(app.root, "app.config.mjs"), 'throw new Error("broken config");\n');
    const result = await exportIn(app.root, [], PATH);
    expect(result).toMatchObject({
      code: 2,
      err: ["tide: expo config failed with exit code 1"],
    });
    expect(existsSync(result.dir)).toBe(false);
  });

  test("an existing --out is refused and left as it was", async () => {
    const out = tempRoot();
    writeFileSync(join(out, "kept"), "kept");
    const app = project();
    const result = await exportIn(app.root, ["--out", out], PATH);
    expect(result).toMatchObject({
      code: 2,
      out: [],
      err: ["tide: --out already exists: give a new directory"],
    });
    expect(files(out)).toEqual(["kept"]);
  });

  test("a corrupt Expo export leaves no tide-export.json", async () => {
    const app = project();
    // Expo copies public/ over its output, so this replaces the metadata it wrote.
    mkdirSync(join(app.root, "public"));
    writeFileSync(join(app.root, "public", "metadata.json"), "not json");
    const result = await exportIn(app.root, [], PATH);
    expect(result).toMatchObject({
      code: 2,
      out: [],
      err: ["tide: export metadata.json is not UTF-8 JSON"],
    });
    expect(files(result.dir)).toEqual([]);
  });

  test("a public config that would make tide-export.json over 16 MiB is refused before --out is created", async () => {
    // The full config stays under the 16 MiB stdout limit; the certificate pushes the export file over it.
    const app = project({ overrides: { extra: { padding: "x".repeat(16 * 1024 * 1024 - 600) } } });
    const result = await exportIn(app.root, [], PATH);
    expect(result).toMatchObject({
      code: 2,
      err: ["tide: tide-export.json would be over 16777216 bytes"],
    });
    expect(existsSync(result.dir)).toBe(false);
  });

  test("a missing --out is a usage error", async () => {
    const app = project();
    const result = await run(MAIN, ["export", "--project-root", app.root], PATH);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`tide: --out is required; ${EXPORT_USAGE}\n`);
  });
});

describe("--base-bytecode", () => {
  const BUNDLE = "dist/_expo/static/js/android/index-android.hbc";
  const IOS_BUNDLE = "dist/_expo/static/js/ios/index-ios.hbc";
  const EMBEDDED = fakeHbc(utf8("// android\nembedded"));
  const EXPO_COMPILE: unknown[] = [
    "-emit-binary",
    "-out",
    expect.stringMatching(/\/index\.hbc$/),
    expect.stringMatching(/\/index\.js$/),
    "-O",
  ];
  const DELTA_COMPILE = [
    ...EXPO_COMPILE,
    expect.stringMatching(/^-base-bytecode=\/.+\/base\.hbc$/),
  ];
  // What /bin/sh adds running a shim, and macOS to every process.
  const SHELL = new Set(["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"]);
  const own = (seen: Record<string, string>) =>
    Object.fromEntries(Object.entries(seen).filter(([k]) => !SHELL.has(k)));
  const CHILD_ENV = {
    ...PATH,
    EXPO_NO_DOTENV: "1",
    NODE_ENV: "production",
    BABEL_ENV: "production",
  };

  /** A project with the fake hermesc installed, whose app.js is `js`. */
  const hermesProject = (js = "one") => {
    const app = project();
    const hermes = installFakeHermes(app.root);
    writeFileSync(join(app.root, "app.js"), js);
    return { app, hermes };
  };
  const file = (bytes: Uint8Array | string) => {
    const path = join(tempRoot(), "base.hbc");
    writeFileSync(path, bytes);
    return path;
  };
  const read = (dir: string, path: string) => new Uint8Array(readFileSync(join(dir, path)));
  const js = (platform: string, body: string) => utf8(`// ${platform}\n${body}`);

  test("Expo compiles the launch bundle against the base with its own JS and flags; every other file is a plain export's", async () => {
    const { app, hermes } = hermesProject();
    const plain = await exportIn(app.root, ["--platform", "android"], PATH);
    expect(hermes().map((r) => r.args)).toEqual([EXPO_COMPILE]);
    const base = file(EMBEDDED);
    const delta = await exportIn(
      app.root,
      ["--platform", "android", "--base-bytecode", `android=${base}`],
      PATH,
    );
    expect(delta).toMatchObject({ code: 0, out: plain.out, err: [] });
    expect(read(plain.dir, BUNDLE)).toEqual(fakeHbc(js("android", "one")));
    expect(read(delta.dir, BUNDLE)).toEqual(fakeHbc(js("android", "one"), EMBEDDED));
    const [before, after] = [tree(plain.dir), tree(delta.dir)];
    before.delete(BUNDLE);
    after.delete(BUNDLE);
    expect(after).toEqual(before);
    expect(hermes().map((r) => r.args)).toEqual([EXPO_COMPILE, ["-version"], DELTA_COMPILE]);
  });

  test("every hermesc run gets the export's allowlisted environment; only Expo's sees the override", async () => {
    const { app, hermes } = hermesProject();
    const caller = { ...PATH, AWS_SECRET_ACCESS_KEY: "x", TIDE_SIGNING_KEY: "x", OTHER: "x" };
    expect((await exportIn(app.root, ["--platform", "android"], caller)).code).toBe(0);
    // A plain export runs only Expo's compile, as Expo resolves hermesc on its own.
    expect(hermes().map((r) => [r.args, own(r.env)])).toEqual([[EXPO_COMPILE, CHILD_ENV]]);
    expect(app.log().find((l) => l.args[0] === "export")?.env).not.toHaveProperty(
      "REACT_NATIVE_OVERRIDE_HERMES_DIR",
    );
    const result = await exportIn(
      app.root,
      ["--platform", "android", "--base-bytecode", `android=${file(EMBEDDED)}`],
      caller,
    );
    expect(result.code).toBe(0);
    const [version, wrapped] = hermes().slice(1);
    expect(own(version?.env ?? {})).toEqual(CHILD_ENV);
    const { REACT_NATIVE_OVERRIDE_HERMES_DIR: override, ...wrappedEnv } = own(wrapped?.env ?? {});
    expect(wrappedEnv).toEqual(CHILD_ENV);
    expect(override?.endsWith("/override")).toBe(true);
    // Tide's own run starts outside the project.
    expect(version?.cwd.startsWith(app.root)).toBe(false);
  });

  test("an ios export compiles its launch bundle against an ios base", async () => {
    const { app } = hermesProject();
    const iosBase = fakeHbc(js("ios", "embedded"));
    const result = await exportIn(
      app.root,
      ["--platform", "ios", "--base-bytecode", `ios=${file(iosBase)}`],
      PATH,
    );
    expect(result).toMatchObject({ code: 0, out: ["ios 1.0.0"] });
    expect(read(result.dir, IOS_BUNDLE)).toEqual(fakeHbc(js("ios", "one"), iosBase));
  });

  test("hermesc resolves from the real app directory, as Expo's does, through to react-native's sdks", async () => {
    // A workspace whose dependencies are hoisted to its root, with the app reached through a link elsewhere.
    const workspace = tempRoot();
    const hermes = installFakeHermes(workspace, "sdks");
    rmSync(join(workspace, "node_modules", "hermes-compiler", "hermesc"), {
      recursive: true,
      force: true,
    });
    const real = join(workspace, "apps", "app");
    installFakeExpo(real);
    project({ root: real });
    writeFileSync(join(real, "app.js"), "one");
    const link = join(tempRoot(), "app");
    symlinkSync(real, link);
    const result = await exportIn(
      link,
      ["--platform", "android", "--base-bytecode", `android=${file(EMBEDDED)}`],
      PATH,
    );
    expect(result).toMatchObject({ code: 0, err: [] });
    expect(read(result.dir, BUNDLE)).toEqual(fakeHbc(js("android", "one"), EMBEDDED));
    expect(hermes().map((r) => r.args)).toEqual([["-version"], DELTA_COMPILE]);
  });

  const BASED = (base: string) => ["--platform", "android", "--base-bytecode", `android=${base}`];
  test("a hermesc selected with --pass-env REACT_NATIVE_OVERRIDE_HERMES_DIR is the one checked and wrapped", async () => {
    const { app, hermes } = hermesProject();
    const selected = installFakeHermes(app.root, "override");
    const result = await exportIn(
      app.root,
      ["--pass-env", "REACT_NATIVE_OVERRIDE_HERMES_DIR", ...BASED(file(EMBEDDED))],
      // Relative, as Expo reads it: against the project directory.
      { ...PATH, REACT_NATIVE_OVERRIDE_HERMES_DIR: "hermes-override" },
    );
    expect(result).toMatchObject({ code: 0, err: [] });
    expect(read(result.dir, BUNDLE)).toEqual(fakeHbc(js("android", "one"), EMBEDDED));
    expect(selected().map((r) => r.args)).toEqual([["-version"], DELTA_COMPILE]);
    expect(hermes()).toEqual([]);
  });

  const ONE_PLATFORM =
    "--base-bytecode compiles one platform: give one base and one --platform, and export each platform on its own";
  test.each<[string, (base: string) => string[], string]>([
    [
      "a missing base",
      () => ["--base-bytecode", "android=missing.hbc"],
      "--base-bytecode android is missing or unreadable",
    ],
    [
      "a directory",
      (b) => ["--base-bytecode", `android=${join(b, "..")}`],
      "--base-bytecode android is not a regular file",
    ],
    [
      "an 11-byte file",
      () => ["--base-bytecode", `android=${file(EMBEDDED.slice(0, 11))}`],
      "--base-bytecode android is not Hermes bytecode",
    ],
    [
      "a magic with no version",
      () => ["--base-bytecode", `android=${file(EMBEDDED.slice(0, 8))}`],
      "--base-bytecode android is not Hermes bytecode",
    ],
    [
      "another format",
      () => ["--base-bytecode", `android=${file("x".repeat(64))}`],
      "--base-bytecode android is not Hermes bytecode",
    ],
    [
      "an unselected platform",
      (b) => ["--base-bytecode", `ios=${b}`],
      "--base-bytecode ios is not the platform this export selects",
    ],
    [
      "two platforms",
      (b) => ["--platform", "ios", "--base-bytecode", `android=${b}`],
      ONE_PLATFORM,
    ],
    [
      "an unknown platform",
      (b) => ["--base-bytecode", `web=${b}`],
      "--base-bytecode platform must be ios or android",
    ],
    [
      "two bases",
      (b) => ["--base-bytecode", `android=${b}`, "--base-bytecode", `android=${b}`],
      ONE_PLATFORM,
    ],
    ["no file", () => ["--base-bytecode", "android="], "--base-bytecode must be <platform>=<file>"],
    ["no =", (b) => ["--base-bytecode", b], "--base-bytecode must be <platform>=<file>"],
  ])("%s is refused before any child runs", async (_, args, message) => {
    const { app, hermes } = hermesProject();
    const result = await exportIn(
      app.root,
      ["--platform", "android", ...args(file(EMBEDDED))],
      PATH,
    );
    expect(result).toMatchObject({ code: 2, out: [], err: [`tide: ${message}`] });
    expect(hermes()).toEqual([]);
    expect(readdirSync(app.root)).not.toContain("fake-expo.log");
    expect(existsSync(result.dir)).toBe(false);
  });

  const modules = (root: string, ...path: string[]) => join(root, "node_modules", ...path);
  test.each<[string, (root: string) => void, string]>([
    [
      "no react-native",
      (root) => rmSync(modules(root, "react-native"), { recursive: true }),
      "react-native is not installed in the project: --base-bytecode needs it",
    ],
    [
      "no hermes-compiler",
      (root) => rmSync(modules(root, "hermes-compiler"), { recursive: true }),
      "hermes-compiler is not installed in the project: --base-bytecode needs it",
    ],
    [
      "no hermesc",
      (root) => rmSync(modules(root, "hermes-compiler", "hermesc"), { recursive: true }),
      "no hermesc is installed under react-native or hermes-compiler",
    ],
    [
      "a hermesc that cannot start",
      (root) => {
        const host = process.platform === "darwin" ? "osx-bin" : "linux64-bin";
        chmodSync(modules(root, "hermes-compiler", "hermesc", host, "hermesc"), 0o644);
      },
      "hermesc -version could not be started",
    ],
  ])("%s is refused before any child runs", async (_, remove, message) => {
    const { app, hermes } = hermesProject();
    remove(app.root);
    const result = await exportIn(app.root, BASED(file(EMBEDDED)), PATH);
    expect(result).toMatchObject({ code: 2, out: [], err: [`tide: ${message}`] });
    expect(hermes()).toEqual([]);
    expect(readdirSync(app.root)).not.toContain("fake-expo.log");
    expect(existsSync(result.dir)).toBe(false);
  });

  test("a base of another bytecode version is refused after hermesc -version, before Expo runs", async () => {
    const { app, hermes } = hermesProject();
    const old = fakeHbc(js("android", "embedded"), undefined, FAKE_VERSION - 3);
    const result = await exportIn(app.root, BASED(file(old)), PATH);
    expect(result).toMatchObject({
      code: 2,
      err: [`tide: --base-bytecode android is bytecode version 96; the app's hermesc writes 99`],
    });
    expect(hermes().map((r) => r.args)).toEqual([["-version"]]);
    expect(readdirSync(app.root)).not.toContain("fake-expo.log");
    expect(existsSync(result.dir)).toBe(false);
  });

  test("a launch bundle that is not bytecode of the base's version is refused and leaves no tide-export.json", async () => {
    const { app } = hermesProject();
    // Expo copies public/ over its output.
    const bundle = join(
      app.root,
      "public",
      "_expo",
      "static",
      "js",
      "android",
      "index-android.hbc",
    );
    mkdirSync(join(bundle, ".."), { recursive: true });
    writeFileSync(bundle, "plain js");
    const result = await exportIn(app.root, BASED(file(EMBEDDED)), PATH);
    expect(result).toMatchObject({
      code: 2,
      out: [],
      err: [`tide: the android launch bundle is not Hermes bytecode version ${FAKE_VERSION}`],
    });
    expect(files(result.dir)).toEqual([]);
  });

  test("an Expo that does not run the wrapper is refused and leaves no tide-export.json", async () => {
    const { app, hermes } = hermesProject();
    const result = await exportIn(
      app.root,
      ["--pass-env", "FAKE_EXPO_IGNORES_OVERRIDE", ...BASED(file(EMBEDDED))],
      { ...PATH, FAKE_EXPO_IGNORES_OVERRIDE: "1" },
    );
    expect(result).toMatchObject({
      code: 2,
      out: [],
      err: ["tide: expo export did not run hermesc through REACT_NATIVE_OVERRIDE_HERMES_DIR"],
    });
    expect(hermes().map((r) => r.args)).toEqual([["-version"], EXPO_COMPILE]);
    expect(files(result.dir)).toEqual([]);
  });

  test("publish stores patches to the delta bundle from the embedded base and the plain OTA update, each rebuilding it", async () => {
    const { app } = hermesProject("one");
    const bucket = tempRoot();
    const store = env({ TIDE_DISK_DIR: bucket });
    const tide = async (...args: string[]) => {
      const result = await run(MAIN, args, store, app.root);
      expect([args[0], result.code, result.stderr]).toEqual([args[0], 0, ""]);
    };
    // The plain OTA update first: register-build needs the bucket's identity a publish writes.
    const ota = await exportIn(app.root, ["--platform", "android"], PATH);
    await tide("publish", "--from", ota.dir, "--channel", "main");
    const build = tempRoot();
    writeFileSync(join(build, "app.manifest"), JSON.stringify({ id: randomUUID(), assets: [] }));
    writeFileSync(join(build, "index.android.bundle"), EMBEDDED);
    await tide(
      ...["register-build", "--platform", "android", "--runtime-version", "1.0.0"],
      ...[
        "--manifest",
        join(build, "app.manifest"),
        "--bundle",
        join(build, "index.android.bundle"),
      ],
    );
    writeFileSync(join(app.root, "app.js"), "two");
    const delta = await exportIn(
      app.root,
      [
        "--platform",
        "android",
        "--base-bytecode",
        `android=${join(build, "index.android.bundle")}`,
      ],
      PATH,
    );
    expect(delta.code).toBe(0);
    await tide("publish", "--from", delta.dir, "--channel", "main");

    const target = read(delta.dir, BUNDLE);
    expect(target).toEqual(fakeHbc(js("android", "two"), EMBEDDED));
    const hex = async (bytes: Uint8Array<ArrayBuffer>) => contentKey(await sha256Base64Url(bytes));
    const objects = diskObjects(bucket);
    for (const base of [EMBEDDED, read(ota.dir, BUNDLE)]) {
      const patch = objects.get(patchKey(await hex(base), await hex(target)));
      expect(patch).toBeDefined();
      const applied = new Uint8Array(applyBsdiff(base, patch ?? new Uint8Array(), target.length));
      expect(await hex(applied)).toBe(await hex(target));
    }
  });
});
