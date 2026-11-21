import { parseArgs } from "node:util";

const PLATFORMS = ["android", "ios"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The expo-updates lines under test: the oldest with bsdiff support and the latest stable. */
export const EXPO_VERSIONS = {
  "55": "bsdiff opt-in via enableBsdiffPatchSupport; embedded-base patches from 55.0.31",
  "58": "bsdiff on by default; embedded-base patches from 58.0.1",
} as const;
export type ExpoVersion = keyof typeof EXPO_VERSIONS;

/** Every scenario, in the order a run takes them. */
export const SCENARIOS = {
  embedded: "the build runs its embedded update and gets no update",
  full: "a first update downloads the full bundle",
  "patch-ota": "an update patches from the running OTA update",
  "corrupt-patch": "a tampered patch falls back to the full bundle",
  rollback: "a rollback directive returns to the embedded update",
  "patch-embedded": "an update patches from the embedded bundle",
} as const;
export type Scenario = keyof typeof SCENARIOS;

const list = (table: Readonly<Record<string, string>>) =>
  Object.entries(table)
    .map(([name, about]) => `  ${name.padEnd(16)}${about}`)
    .join("\n");

export const USAGE = `usage: pnpm conformance --platform <${PLATFORMS.join("|")}> [--expo <version>]... [--scenario <name>]... [--avd <name>]

Runs stock expo-updates release apps against a local Tide. Every version and scenario runs unless named.

Android uses the running emulator (ANDROID_SERIAL picks one of several), or boots the AVD --avd names (the first
listed by default) read-only and shuts it down at the end. ANDROID_HOME must name the Android SDK.

Platforms: ${PLATFORMS.join(", ")}

expo-updates versions (--expo):
${list(EXPO_VERSIONS)}

Scenarios (--scenario):
${list(SCENARIOS)}`;

export class UsageError extends Error {}

export interface Run {
  readonly platform: Platform;
  readonly versions: readonly ExpoVersion[];
  readonly scenarios: readonly Scenario[];
  readonly avd: string | undefined;
}

/** Returns the run `args` ask for, or `help`; anything else is a `UsageError`. */
export function parseRun(args: readonly string[]): Run | "help" {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        help: { type: "boolean", short: "h" },
        platform: { type: "string", multiple: true },
        expo: { type: "string", multiple: true },
        scenario: { type: "string", multiple: true },
        avd: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new UsageError("unrecognised arguments");
  }
  if (values.help === true) return "help";
  const [platform, ...more] = values.platform ?? [];
  if (more.length > 0) throw new UsageError("give --platform once");
  if (!PLATFORMS.includes(platform as Platform)) {
    throw new UsageError(`--platform must be ${PLATFORMS.join(" or ")}`);
  }
  return {
    platform: platform as Platform,
    versions: pick(EXPO_VERSIONS, values.expo, "--expo"),
    scenarios: pick(SCENARIOS, values.scenario, "--scenario"),
    avd: values.avd,
  };
}

/** Returns the named keys of `table` in table order, or all of them when none is named. */
function pick<K extends string>(
  table: Readonly<Record<K, unknown>>,
  named: readonly string[] | undefined,
  flag: string,
): K[] {
  const keys = Object.keys(table) as K[];
  for (const name of named ?? []) {
    if (!Object.hasOwn(table, name))
      throw new UsageError(`${flag} must be one of ${keys.join(", ")}`);
  }
  return named === undefined ? keys : keys.filter((k) => named.includes(k));
}
