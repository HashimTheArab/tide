// The options of `pnpm hermes-delta`.
import { parseArgs } from "node:util";

import type { AppId } from "./apps.ts";
import { APPS, CHANGES } from "./apps.ts";

const list = (table: Readonly<Record<string, string | { title: string }>>) =>
  Object.entries(table)
    .map(([k, v]) => `  ${k.padEnd(18)}${typeof v === "string" ? v : v.title}`)
    .join("\n");

export const USAGE = `usage: pnpm hermes-delta [--app <id>]...

Measures Tide's bsdiff patches between consecutive Hermes bundles built as expo export builds them, and built
from the same JS with hermesc -base-bytecode against a bundle devices already run: the previous OTA update, or
the bundle the release build embeds. Android only. Every app is rebuilt from pinned inputs; reruns give the same
sizes.

Per app it builds the embedded bundle (as the React Native Gradle plugin does) and an OTA export of the start
tree, an OTA export after previous.patch, and for each change the plain export and two delta compiles of its JS.
Each patch is makeBsdiff output that passed checkPatch, measured from the OTA base, the embedded base and the
older OTA update. Each app's results go to docs/assets/hermes-delta/<app>.json and <app>.md. Trees, installs
and build caches are kept between runs in the gitignored .cache/hermes-delta.

Network: only cloning a pinned app and installing locked packages. Nothing calls Cloudflare, AWS or a Tide.

Options:
  --app <id>        an app to measure (repeatable; all by default); other apps' files are left alone

Apps:
${list(APPS)}

Changes:
${list(CHANGES)}`;

export class UsageError extends Error {}

export interface Options {
  readonly apps: readonly AppId[];
}

/** Returns the options `args` ask for, or `help`; anything else is a `UsageError`. */
export function parseOptions(args: readonly string[]): Options | "help" {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        help: { type: "boolean", short: "h" },
        app: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new UsageError("unrecognised arguments");
  }
  if (values.help === true) return "help";
  const ids = Object.keys(APPS) as AppId[];
  for (const app of values.app ?? []) {
    if (!Object.hasOwn(APPS, app)) throw new UsageError(`--app must be one of ${ids.join(", ")}`);
  }
  return { apps: values.app === undefined ? ids : ids.filter((id) => values.app?.includes(id)) };
}
