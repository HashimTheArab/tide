// The options of `pnpm hermes-delta`.
import { parseArgs } from "node:util";

import type { AppId } from "./apps.ts";
import { APPS, CHANGES } from "./apps.ts";

const list = (table: Readonly<Record<string, string | { title: string }>>) =>
  Object.entries(table)
    .map(([k, v]) => `  ${k.padEnd(18)}${typeof v === "string" ? v : v.title}`)
    .join("\n");

export const USAGE = `usage: pnpm hermes-delta [--app <id>]...
       pnpm hermes-delta --emulator [--app sdk-55|sdk-58]... [--avd <name>]

Measures Tide's bsdiff patches between consecutive Hermes bundles built as expo export builds them, and built
from the same JS with hermesc -base-bytecode against a bundle devices already run: the previous OTA update, or
the bundle the release build embeds. Android only. Every app is rebuilt from pinned inputs; reruns give the same
sizes.

Per app it builds the embedded bundle (as the React Native Gradle plugin does) and an OTA export of the start
tree, an OTA export after previous.patch, and for each change the plain export and two delta compiles of its JS.
Each patch is makeBsdiff output that passed checkPatch, measured from the OTA base, the embedded base and the
older OTA update; the bundle delta-compiled against the embedded base is also measured from both OTA updates
compiled against the embedded base, as they are once every update is. Each app's results go to
docs/assets/hermes-delta/<app>.json and <app>.md. Trees, installs
and build caches are kept between runs in the gitignored .cache/hermes-delta.

With --emulator it measures nothing. It builds each conformance app's release APK for the running emulator, or
the AVD --avd names booted read-only, publishes to a local Tide over a disk store, and checks that an update
delta-compiled against an OTA update no device ran launches on a device on the embedded build and on a device on
another OTA update, from a patch and from the full bundle. Results go to docs/assets/hermes-delta/emulator-<app>.json
and .md. ANDROID_HOME names the Android SDK; ANDROID_SERIAL picks one of several running emulators.

Network: only cloning a pinned app and installing locked packages. Nothing calls Cloudflare, AWS or a remote Tide.

Options:
  --app <id>        an app to measure (repeatable; all by default); other apps' files are left alone
  --emulator        run the device check instead (sdk-55 and sdk-58 by default)
  --avd <name>      the AVD to boot when no emulator is running (with --emulator)

Apps:
${list(APPS)}

Changes:
${list(CHANGES)}`;

export class UsageError extends Error {}

/** The apps the emulator check builds: the conformance apps, whose source reports each launch. */
const EMULATOR_APPS = ["sdk-55", "sdk-58"] as const satisfies readonly AppId[];
export type EmulatorApp = (typeof EMULATOR_APPS)[number];

export type Options =
  | { readonly emulator: false; readonly apps: readonly AppId[] }
  | {
      readonly emulator: true;
      readonly apps: readonly EmulatorApp[];
      readonly avd: string | undefined;
    };

/** Returns the options `args` ask for, or `help`; anything else is a `UsageError`. */
export function parseOptions(args: readonly string[]): Options | "help" {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        help: { type: "boolean", short: "h" },
        app: { type: "string", multiple: true },
        emulator: { type: "boolean" },
        avd: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new UsageError("unrecognised arguments");
  }
  if (values.help === true) return "help";
  if (values.emulator === true) {
    return {
      emulator: true,
      apps: pick(EMULATOR_APPS, values.app, " with --emulator"),
      avd: values.avd,
    };
  }
  if (values.avd !== undefined) throw new UsageError("--avd is for --emulator");
  return { emulator: false, apps: pick(Object.keys(APPS) as AppId[], values.app, "") };
}

/** Returns the named ids in `ids` order, or all of them when none is named. */
function pick<K extends string>(
  ids: readonly K[],
  named: readonly string[] | undefined,
  note: string,
): K[] {
  for (const app of named ?? []) {
    if (!(ids as readonly string[]).includes(app)) {
      throw new UsageError(`--app must be one of ${ids.join(", ")}${note}`);
    }
  }
  return named === undefined ? [...ids] : ids.filter((id) => named.includes(id));
}
