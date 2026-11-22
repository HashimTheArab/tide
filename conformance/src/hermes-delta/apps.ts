// The apps the Hermes delta study builds, each pinned to exact source, and the changes it measures on them.

/** The Tide commit the conformance apps' source is read from, so later edits to them never move the numbers. */
const TIDE_COMMIT = "e016cf8ee01b92d461317d9423d85b0bbe197a1d";

/** The changes measured on every app, each a patch onto the previous update's tree. */
export const CHANGES = {
  "one-line": "one line of app code",
  "dependency-bump": "a JavaScript dependency raised by a few releases, lockfile included",
  feature: "a feature-sized change: a new component and its wiring",
} as const;
export type ChangeId = keyof typeof CHANGES;

/** Where an app's pinned tree comes from. */
type Source =
  | {
      readonly kind: "tide"; // Files read from this repository at TIDE_COMMIT.
      readonly commit: string;
      readonly files: Readonly<Record<string, string>>; // Tree path by repository path.
      readonly extra: Readonly<Record<string, string>>; // Files written beside them, by tree path.
    }
  | { readonly kind: "git"; readonly url: string; readonly commit: string };

export interface AppPin {
  readonly title: string;
  readonly source: Source;
  /**
   * Installs the locked dependencies without running their scripts. This and `prepare` run from the app's work
   * directory with `<tree>` standing for its tree, so npm's devEngines check never sees the app's own package.json.
   */
  readonly install: readonly string[];
  readonly prepare: readonly (readonly string[])[]; // The app's own code generation, run after each install.
  readonly env: Readonly<Record<string, string>>; // Build-time variables the app's own OTA pipeline sets.
  /**
   * Patch files under conformance/hermes-delta/patches. The start tree is the pin with `dependency-bump` reversed,
   * so every bump lands on versions the pin already resolved; `previous` turns the start tree into the OTA base.
   */
  readonly patches: Readonly<Record<ChangeId | "previous", string>>;
}

const conformanceApp = (version: "55" | "58"): AppPin => ({
  title: `Tide conformance app, Expo SDK ${version}`,
  source: {
    kind: "tide",
    commit: TIDE_COMMIT,
    files: {
      "conformance/apps/shared/App.js": "App.js",
      "conformance/apps/shared/cleartext.js": "cleartext.js",
      "conformance/apps/shared/image.png": "image.png",
      "conformance/apps/shared/index.js": "index.js",
      [`conformance/apps/sdk-${version}/package.json`]: "package.json",
      [`conformance/apps/sdk-${version}/package-lock.json`]: "package-lock.json",
    },
    extra: {
      "app.json": `${JSON.stringify(
        {
          expo: {
            name: `Tide conformance ${version}`,
            slug: "tide-conformance",
            version: "1.0.0",
            runtimeVersion: `1.0.0-sdk${version}`,
            android: { package: `dev.tide.conformance.sdk${version}` },
            ios: { bundleIdentifier: `dev.tide.conformance.sdk${version}` },
          },
        },
        null,
        2,
      )}\n`,
      "marker.js": 'export const MARKER = "hermes-delta";\n',
    },
  },
  install: ["npm", "ci", "--prefix", "<tree>", "--ignore-scripts", "--no-audit", "--no-fund"],
  prepare: [],
  env: {},
  patches: {
    previous: "conformance/previous.patch",
    "one-line": "conformance/one-line.patch",
    "dependency-bump": `sdk-${version}/dependency-bump.patch`,
    feature: "conformance/feature.patch",
  },
});

const PNPM = ["npx", "--yes", "pnpm@12.16.1", "--dir", "<tree>"];

export const APPS = {
  "sdk-55": conformanceApp("55"),
  "sdk-58": conformanceApp("58"),
  bluesky: {
    title: "Bluesky social-app (Expo SDK 58)",
    source: {
      kind: "git",
      url: "https://github.com/bluesky-social/social-app.git",
      commit: "17393322eec4f22bfb0d07bd27c3d2af1db8d398",
    },
    // The pnpm its lockfile was written by; older ones cannot read it.
    install: [...PNPM, "install", "--frozen-lockfile", "--ignore-scripts"],
    // Its postinstall, without the dependency scripts --ignore-scripts skips.
    prepare: [
      [...PNPM, "lexicons:generate"],
      [...PNPM, "intl:compile"],
    ],
    // As its production OTA workflow, without the secrets.
    env: { EXPO_PUBLIC_ENV: "production" },
    patches: {
      previous: "bluesky/previous.patch",
      "one-line": "bluesky/one-line.patch",
      "dependency-bump": "bluesky/dependency-bump.patch",
      feature: "bluesky/feature.patch",
    },
  },
} as const satisfies Record<string, AppPin>;
export type AppId = keyof typeof APPS;
