// Drives the Tide CLI as an operator's CI would, against a stack's store and the stack's identities only.
import { generateKeyPair } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Platform } from "./options.ts";
import type { Identity, Stack } from "./stack.ts";
import { hostEnv } from "./stack.ts";

const CLI = fileURLToPath(new URL("../../packages/cli/src/main.ts", import.meta.url));

interface Pointer {
  readonly channel: string;
  readonly runtimeVersion: string;
  readonly platform: Platform;
}

export interface TideCli {
  /** Runs `tide export` on the project at `projectRoot` into the new directory `out`, delta-compiled against `base`. */
  export(
    projectRoot: string,
    out: string,
    platforms: readonly Platform[],
    runtimeVersion?: string,
    base?: string,
  ): Promise<void>;
  /** Publishes the export at `from`, with `--add-identity` if so, and returns each written pointer's update ID by platform. */
  publish(
    from: string,
    channel: string,
    addIdentity?: boolean,
  ): Promise<Partial<Record<Platform, string>>>;
  registerBuild(build: {
    readonly platform: Platform;
    readonly runtimeVersion: string;
    readonly manifest: string;
    readonly bundle: string;
    readonly assetsDir?: string; // Required when the manifest lists assets.
  }): Promise<void>;
  rollbackToEmbedded(pointer: Pointer): Promise<void>;
  /** Returns `tide probe`'s report of what the stack serves for `pointer`. */
  probe(pointer: Pointer): Promise<string>;
}

/**
 * Returns a driver whose commands run with exactly the variables of the stack and `identity`, and are stopped when the
 * stack closes.
 */
export function tideCli(stack: Stack, identity: Identity = stack.identity): TideCli {
  const pins: Record<string, string> = {
    TIDE_BUILD_KEYID: identity.keyId,
    TIDE_BUILD_CERTIFICATE_FILE: identity.certificateFile,
    ...(identity.chainFile !== undefined && { TIDE_BUILD_INCLUDE_CERTIFICATE_CHAIN: "true" }),
  };
  const write = {
    ...pins,
    ...(identity.chainFile !== undefined && { TIDE_CERTIFICATE_CHAIN_FILE: identity.chainFile }),
    TIDE_SIGNING_KEY_FILE: identity.keyFile,
    TIDE_SERVER_URL: stack.serverUrl,
    TIDE_ASSET_URL: stack.serverUrl,
    TIDE_DISK_DIR: stack.storeDir,
  };
  const tide = (args: string[], env: Record<string, string>) => run(stack, args, env);
  const at = (p: Pointer) => [
    "--channel",
    p.channel,
    "--runtime-version",
    p.runtimeVersion,
    "--platform",
    p.platform,
  ];
  return {
    async export(projectRoot, out, platforms, runtimeVersion, base) {
      const env = hostEnv();
      // The export stages Expo's output under TMPDIR, so a killed export leaves nothing outside the stack.
      env.TMPDIR = await mkdtemp(join(stack.dir, "tmp-"));
      const selected = platforms.flatMap((p) => ["--platform", p]);
      const runtime = runtimeVersion === undefined ? [] : ["--runtime-version", runtimeVersion];
      const based = base === undefined ? [] : ["--base-bytecode", `${platforms[0]}=${base}`];
      await tide(
        ["export", "--project-root", projectRoot, "--out", out, ...selected, ...runtime, ...based],
        env,
      );
    },
    async publish(from, channel, addIdentity = false) {
      const add = addIdentity ? ["--add-identity"] : [];
      const stdout = await tide(["publish", "--from", from, "--channel", channel, ...add], write);
      // One `<pointer key> <update ID> <createdAt>` line per pointer written.
      const ids: Partial<Record<Platform, string>> = {};
      for (const line of stdout.trimEnd().split("\n")) {
        const [key = "", updateId = ""] = line.split(" ");
        ids[key.split("/")[3] as Platform] = updateId;
      }
      return ids;
    },
    async registerBuild(build) {
      await tide(
        [
          "register-build",
          "--platform",
          build.platform,
          "--runtime-version",
          build.runtimeVersion,
          "--manifest",
          build.manifest,
          "--bundle",
          build.bundle,
          ...(build.assetsDir === undefined ? [] : ["--assets-dir", build.assetsDir]),
        ],
        write,
      );
    },
    async rollbackToEmbedded(pointer) {
      await tide(["rollback", "--embedded", ...at(pointer)], write);
    },
    probe: (pointer) => tide(["probe", "--server-url", stack.serverUrl, ...at(pointer)], pins),
  };
}

/**
 * Issues a root and an intermediate with `tide certificate`. Each call of the returned function issues a leaf with a
 * key of its own under them and returns the chain-mode identity that signs with it: the keyid and root stay the same.
 */
export async function chainAuthority(stack: Stack): Promise<() => Promise<Identity>> {
  const dir = await mkdtemp(join(stack.dir, "chain-"));
  const file = (name: string) => join(dir, name);
  const certify = async (name: string, signer: string, days: number, args: readonly string[]) => {
    await writeKey(file(name));
    const pem = await run(
      stack,
      [
        ...["certificate", "--common-name", `Conformance ${name}`],
        ...["--validity-days", String(days), ...args],
      ],
      { TIDE_SIGNING_KEY_FILE: file(`${signer}.key`) },
    );
    await writeFile(file(`${name}.pem`), pem, { flag: "wx" });
    return pem;
  };
  const under = (issuer: string, name: string) => [
    "--issuer",
    file(issuer),
    "--subject-key",
    file(`${name}.pub`),
  ];
  // Each certificate expires before the one above it.
  const root = await certify("root", "root", 30, ["--ca"]);
  const ca = ["--ca", ...under("root.pem", "intermediate")];
  const intermediate = await certify("intermediate", "root", 29, ca);
  await writeFile(file("issuer.pem"), intermediate + root, { flag: "wx" });
  let leaves = 0;
  return async () => {
    const name = `leaf-${++leaves}`;
    const leaf = await certify(name, "intermediate", 28, under("issuer.pem", name));
    const chainFile = file(`${name}-chain.pem`);
    await writeFile(chainFile, leaf + intermediate, { flag: "wx" });
    return {
      keyId: "conformance-chain",
      keyFile: file(`${name}.key`),
      certificateFile: file("root.pem"),
      chainFile,
    };
  };
}

/** Writes a new RSA key as `<base>.key` (PKCS#8 PEM, mode 0600) and `<base>.pub` (SubjectPublicKeyInfo PEM). */
async function writeKey(base: string): Promise<void> {
  const { publicKey, privateKey } = await promisify(generateKeyPair)("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await writeFile(`${base}.key`, privateKey, { mode: 0o600, flag: "wx" });
  await writeFile(`${base}.pub`, publicKey, { flag: "wx" });
}

/** Runs the CLI with exactly `env` and returns its stdout; a non-zero exit or a kill throws with its stderr. */
async function run(stack: Stack, args: string[], env: Record<string, string>) {
  const proc = stack.spawn(process.execPath, [CLI, ...args], env);
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
  proc.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
  const [code, signal] = (await once(proc, "close")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(
      `tide ${args[0]} ${signal ? `was killed by ${signal}` : `exited ${code}`}: ${stderr.trim()}`,
    );
  }
  return stdout;
}
