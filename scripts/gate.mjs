// Prints the delivery loop's gate evidence as JSON: check exit codes, test counts, diff risk and tampering signals.
// The loop runs a copy taken from origin/main at the start of a run, so a branch cannot grade itself.
// Usage: node gate.mjs [--base origin/main] [--diff-only] [--frozen a.ts,b.ts] [--out file.json]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

const argv = process.argv.slice(2);
/** @param {string} name */
const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const base = opt("--base") ?? "origin/main";
const out = opt("--out");
const diffOnly = argv.includes("--diff-only");
const frozenFiles = (opt("--frozen") ?? "").split(",").filter(Boolean);

const CHECKS = {
  typecheck: "pnpm typecheck",
  lint: "pnpm lint",
  lintWorkspace: "pnpm lint:ws",
  format: "pnpm format",
  knip: "pnpm knip",
  test: "pnpm test",
  docs: "pnpm docs:check",
  audit: "pnpm audit --prod --audit-level high",
  // Full history with default rules; no config or allow comment can narrow it.
  secrets:
    "env -u BETTERLEAKS_CONFIG -u GITLEAKS_CONFIG -u BETTERLEAKS_CONFIG_TOML -u GITLEAKS_CONFIG_TOML " +
    'betterleaks git . --log-opts="--full-history -m HEAD" --ignore-gitleaks-allow --redact',
};
// Exact contents allowed in .betterleaksignore (empty: the file must be absent or empty), so a branch cannot widen it.
/** @type {string[]} */
const SECRETS_IGNORE = [];

// A slice touching any of these always gets the deep review.
const RISKY = [
  /^packages\/protocol\//,
  /^packages\/cli\/src\/(sign|keys|publish|pointer|lock|storage)/,
  /^packages\/server\/src\/(core|workers\.ts|node\.ts)/,
  /wrangler\.jsonc$/,
  /^\.github\//,
  /Dockerfile/,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)vitest\.config\./,
  /(^|\/)\.(oxlintrc|oxfmtrc)/,
  /^knip\.json$/,
  /(^|\/)test-utils\//,
  /^scripts\//,
  /^\.claude\//,
  /^AGENTS\.md$/,
  /^docs\/decisions\//,
  /^docs\/(design|testing|delivery-loop)\.md$/,
];
// Changes here also always get the deep review.
const DEEP = [/^packages\/server\/src\//, /^packages\/cli\/src\//];

const TEST_FILE = /(__tests__\/|(^|\/)tests?\/|\.test\.|\.spec\.|\.e2e\.|maestro\/)/;
const TEST_SIGNALS = {
  skipOrOnly: /\.(skip|only|todo|skipIf|runIf|fails)\b/,
  retry: /\bretry\s*:|retries\s*:/,
  mock: /vi\.mock\(|jest\.mock\(/,
  snapshot: /toMatch(Inline)?Snapshot/,
  sleep: /setTimeout\(|waitForTimeout|\bsleep\(/,
};
const ANY_SIGNALS = {
  suppression: /eslint-disable|oxlint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore/,
  envSniffing: /process\.env\.(VITEST|CI|NODE_ENV|JEST_WORKER_ID)/,
};
const SCRIPT_KEY = /^[+-]\s*"(test|lint|typecheck|format|build|check)[^"]*"\s*:/;

/** @param {string} cmd */
const sh = (cmd) => spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
/** @param {string} args */
function git(args) {
  const r = sh(`git -c core.quotePath=false ${args}`);
  if (r.status !== 0) throw new Error(`git ${args} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
function ignoreFileMatches() {
  const want = SECRETS_IGNORE.length ? `${SECRETS_IGNORE.join("\n")}\n` : "";
  return existsSync(".betterleaksignore")
    ? readFileSync(".betterleaksignore", "utf8") === want
    : want === "";
}

function runChecks() {
  /** @type {Record<string, { cmd: string, exitCode: number, seconds: number, tail: string | undefined }>} */
  const results = {};
  const tests = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
  for (const [name, cmd] of Object.entries(CHECKS)) {
    const started = process.hrtime.bigint();
    const r =
      name === "secrets" && !ignoreFileMatches()
        ? {
            status: 1,
            stdout: "",
            stderr: `.betterleaksignore must list exactly:\n${SECRETS_IGNORE.join("\n")}`,
          }
        : sh(cmd);
    const text = stripVTControlCharacters(`${r.stdout}\n${r.stderr}`);
    // The 40-line tail can miss the failing package in interleaved output; CI keeps no other copy.
    if (r.status !== 0 && process.env.GITHUB_ACTIONS)
      process.stderr.write(`::group::${name} output\n${text}\n::endgroup::\n`);
    results[name] = {
      cmd,
      exitCode: r.status ?? -1,
      seconds: Number((process.hrtime.bigint() - started) / 1_000_000n) / 1000,
      tail: r.status === 0 ? undefined : text.split("\n").filter(Boolean).slice(-40).join("\n"),
    };
    if (name === "test") {
      for (const m of text.matchAll(/\bTests\s{2,}([^\n(]*)\((\d+)\)/g)) {
        tests.total += Number(m[2]);
        for (const part of m[1].matchAll(/(\d+) (passed|failed|skipped|todo)/g))
          tests[part[2]] += Number(part[1]);
      }
    }
  }
  return { results, tests };
}

function analyseDiff() {
  const mergeBase = git(`merge-base ${base} HEAD`);
  const headSha = git("rev-parse HEAD");
  if (!/^[0-9a-f]{40}$/.test(mergeBase) || !/^[0-9a-f]{40}$/.test(headSha))
    throw new Error("could not resolve commits");
  const range = `${mergeBase}...HEAD`;
  const status = git(`diff --name-status ${range}`).split("\n").filter(Boolean);
  // Renames and copies count both paths, so moving a file cannot hide it from the risk or test checks.
  const files = [...new Set(status.flatMap((l) => l.split("\t").slice(1)))];
  let changedLines = 0;
  for (const l of git(`diff --numstat ${range}`).split("\n").filter(Boolean)) {
    const [add, del, file] = l.split("\t");
    if (file === "pnpm-lock.yaml" || file.endsWith("worker-configuration.d.ts") || add === "-")
      continue;
    changedLines += Number(add) + Number(del);
  }
  const deletedTests = status
    .filter((l) => /^[DR]/.test(l) && TEST_FILE.test(l.split("\t")[1]))
    .map((l) => l.split("\t")[1]);
  const signals = Object.fromEntries(
    [...Object.keys(TEST_SIGNALS), ...Object.keys(ANY_SIGNALS)].map((k) => [k, []]),
  );
  let removedExpects = 0;
  const scriptChanges = [];
  let current = "";
  for (const line of git(`diff -U0 ${range}`).split("\n")) {
    if (line.startsWith("+++ b/")) current = line.slice(6);
    else if (current.endsWith("worker-configuration.d.ts")) continue;
    else if (line.startsWith("---") || line.startsWith("+++")) continue;
    else if (current.endsWith("package.json") && SCRIPT_KEY.test(line))
      scriptChanges.push(`${current}: ${line}`);
    else if (line.startsWith("-") && TEST_FILE.test(current) && line.includes("expect("))
      removedExpects++;
    else if (line.startsWith("+")) {
      const text = line.slice(1).trim();
      if (TEST_FILE.test(current))
        for (const [k, re] of Object.entries(TEST_SIGNALS))
          if (re.test(text)) signals[k].push(`${current}: ${text}`);
      for (const [k, re] of Object.entries(ANY_SIGNALS))
        if (re.test(text)) signals[k].push(`${current}: ${text}`);
    }
  }
  const riskyFiles = files.filter((f) => RISKY.some((re) => re.test(f)));
  for (const s of scriptChanges) riskyFiles.push(s.split(":")[0]);
  return {
    base,
    baseSha: git(`rev-parse ${base}`),
    mergeBase,
    headSha,
    files,
    changedLines,
    riskyFiles: [...new Set(riskyFiles)],
    deepFiles: files.filter((f) => DEEP.some((re) => re.test(f))),
    tests: {
      changedFiles: files.filter((f) => TEST_FILE.test(f)),
      deletedFiles: deletedTests,
      removedExpects,
      signals,
      scriptChanges,
    },
  };
}

// Checks must run on exactly the commit being reported, never on uncommitted edits.
const dirty = git("status --porcelain");
if (dirty)
  throw new Error(`worktree has uncommitted changes; commit or discard them first:\n${dirty}`);

const frozen = Object.fromEntries(
  frozenFiles.map((f) => [
    f,
    existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : null,
  ]),
);
const diff = analyseDiff();
const checks = diffOnly ? null : runChecks();
if (git("rev-parse HEAD") !== diff.headSha || git("status --porcelain")) {
  throw new Error("HEAD or the working tree changed while checks ran");
}
const report = {
  diff,
  frozen,
  checks: checks?.results ?? null,
  tests: checks?.tests ?? null,
  allChecksPassed: checks ? Object.values(checks.results).every((r) => r.exitCode === 0) : null,
};
const json = JSON.stringify(report, null, 2);
if (out) writeFileSync(out, json);
process.stdout.write(`${json}\n`);
