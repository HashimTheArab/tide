export const meta = {
  name: "implement-phase",
  description:
    "Deliver the next slice of a roadmap phase as one reviewed PR and auto-merge it, or hand it back",
  whenToUse:
    'Run the next slice of a roadmap phase, one slice per run. args: {phase: "P12", slice?: "P12.3", notes?: string, maxRounds?: 3, deepReviewLines?: 400, sliceLines?: 400, autoMerge?: true}',
  phases: [
    { title: "Plan", detail: "Opus plans the phase into slices, or refreshes the plan" },
    {
      title: "Design",
      detail: "risky slices only: Opus writes a design note and Codex reviews it",
    },
    {
      title: "Build",
      detail: "Opus builds the slice in its own worktree; the trusted gate checks it; the PR opens",
    },
    {
      title: "Review",
      detail: "an Opus simplicity pass, then Codex review, a fresh Opus deep review when triggered, and a fresh Opus fixer",
    },
    { title: "Merge", detail: "catch up with main, then auto-merge or label for the owner" },
  ],
};

// ---- Arguments
const REPO = "/Users/hashim/dev/oss/tide";
const a = args || {};
const PHASE = String(a.phase || "").toUpperCase();
if (!/^P\d{1,2}$/.test(PHASE)) throw new Error('args.phase must look like "P12"');
const WANT = a.slice ? String(a.slice).toUpperCase() : null;
if (WANT && !new RegExp(`^${PHASE}\\.\\d{1,2}$`).test(WANT))
  throw new Error(`args.slice must look like "${PHASE}.1"`);
const bounded = (v, d, lo, hi) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
const MAX_ROUNDS = bounded(a.maxRounds, 3, 1, 5);
const DEEP_LINES = bounded(a.deepReviewLines, 400, 50, 5000);
const SLICE_LINES = bounded(a.sliceLines, 400, 100, 3000);
const AUTO_MERGE = a.autoMerge !== false;
const NOTES = a.notes ? `\nOwner's notes for this run: ${a.notes}` : "";
// Reviewers and the arbiter get the same notes as fixed decisions, so they do not re-raise what the owner settled.
const DECISIONS = a.notes
  ? `\nThe owner's notes for this run are fixed decisions: do not report them as findings unless one contradicts the Expo Updates protocol spec or loses correctness, and then say which. Notes: ${a.notes}`
  : "";

// ---- Constants
const OUT = `${REPO}/.agent-output/phases/${PHASE.toLowerCase()}`;
const PLAN = `${OUT}/plan.json`;
const GATE = `${OUT}/trusted/gate.mjs`; // copied from origin/main before every run, so a branch cannot grade itself
const RISKY_PHASES = ["P2", "P3", "P4", "P5"];
const SOL = '-m gpt-6.2-sol -c model_reasoning_effort="high"';
const FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";
const LABEL =
  'gh label create needs-owner --force --color B60205 --description "Waiting for the owner"';

// ---- Schemas
const str = { type: "string" };
const num = { type: "number" };
const strs = { type: "array", items: str };
const oneOf = (...e) => ({ type: "string", enum: e });
const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
});
const SLICE = obj(
  {
    id: str,
    title: str,
    scope: str,
    done: strs,
    risky: { type: "boolean" },
    estLines: num,
    state: str,
    pr: num,
  },
  ["id", "title", "scope", "done", "risky", "estLines", "state"],
);
const PLANNED = obj({
  status: oneOf("ok", "blocked"),
  reason: str,
  slices: { type: "array", items: SLICE },
});
const SH = obj({ exitCode: num, output: str });
const FINDING = obj(
  { severity: oneOf("P0", "P1", "P2", "P3"), file: str, line: num, title: str, scenario: str },
  ["severity", "file", "title", "scenario"],
);
const CONVERTED = obj({
  status: oneOf("findings", "clean", "missing"),
  findings: { type: "array", items: FINDING },
});
const DEEP = obj({
  findings: {
    type: "array",
    items: { ...FINDING, properties: { ...FINDING.properties, severity: oneOf("P1", "P2", "P3") } },
  },
});
const SHOTS = { type: "array", items: obj({ file: str, caption: str }) };
const OUTCOME = obj(
  {
    outcome: oneOf("done", "blocked"),
    reason: str,
    dependencies: strs,
    screensChanged: { type: "boolean" },
    screenshots: SHOTS,
    screenshotNote: str,
  },
  ["outcome", "reason"],
);
const BUILT = obj(
  {
    outcome: oneOf("done", "blocked"),
    reason: str,
    summary: str,
    decisions: strs,
    dependencies: strs,
    tests: strs,
    screensChanged: { type: "boolean" },
    screenshots: SHOTS,
    screenshotNote: str,
  },
  ["outcome", "reason", "summary", "decisions", "dependencies", "tests", "screensChanged"],
);
const FIXED = obj(
  {
    outcome: oneOf("done", "blocked"),
    reason: str,
    dispositions: {
      type: "array",
      items: obj({ id: str, action: oneOf("fixed", "rejected"), reason: str, test: str }, [
        "id",
        "action",
        "reason",
      ]),
    },
    dependencies: strs,
    screensChanged: { type: "boolean" },
    screenshots: SHOTS,
    screenshotNote: str,
  },
  ["outcome", "reason", "dispositions"],
);
const VERDICT = obj({ verdict: oneOf("finding-stands", "rejection-valid"), reason: str });
const CLOSURE = obj({
  results: { type: "array", items: obj({ id: str, closed: { type: "boolean" }, reason: str }) },
});
const SIMPLER = obj({ verdict: oneOf("simplify", "patch"), design: str, reason: str });

// ---- Helpers
class HandBack extends Error {}
const fail = (why) => {
  throw new HandBack(why);
};
const must = (v, what) => v ?? fail(`${what} returned nothing; missing evidence is never success`);
const done = (r, what) =>
  must(r, what).outcome === "done"
    ? r
    : fail(`${what} reported it cannot be done honestly: ${r.reason}`);
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const safe = (s) =>
  String(s)
    .replace(/[^A-Za-z0-9 ,.:()/-]/g, "")
    .slice(0, 90);
const sev = { P0: 0, P1: 1, P2: 2, P3: 3 };
const blocking = (f, r) => sev[f.severity] <= 1 || (f.severity === "P2" && r <= 2);
const brief = (f) => `${f.id} ${f.severity} ${f.file}${f.line ? `:${f.line}` : ""}: ${f.title}`;
const bullets = (xs, none) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : none);
// A dropped connection returns no result; one retry absorbs it, and a second empty result still hands back.
const call = async (prompt, opts) => {
  const r = await agent(prompt, opts);
  if (r != null) return r;
  log(`${opts.label}: no result, retrying once`);
  return agent(prompt, opts);
};
const opus = (prompt, label, schema) =>
  call(prompt, { label, model: "opus", effort: "high", schema });

const fileBlocks = (files) =>
  Object.entries(files)
    .map(([p, c]) => `<<<FILE ${p}\n${c}\nFILE>>>`)
    .join("\n");

// Runs one exact command through a small agent; the script judges the exit code.
async function sh(label, cmd, files = {}) {
  const writes = fileBlocks(files);
  return must(
    await call(
      `You run one step of a scripted workflow. Do exactly this and nothing else; never retry, fix or interpret anything.
${writes ? `1. With the Write tool, write each file below with exactly the text between its markers, not the markers:\n${writes}\n2. ` : ""}Run this command with the Bash tool and a 600000 ms timeout:
${cmd}
Return its exit code and the last 6000 characters of its output.`,
      { label, model: "sonnet", effort: "low", schema: SH },
    ),
    label,
  );
}
async function ok(label, cmd, files) {
  const r = await sh(label, cmd, files);
  if (r.exitCode !== 0) fail(`${label} failed (exit ${r.exitCode}): ${r.output.slice(-800)}`);
  return r.output;
}

// Long commands run under nohup with an exit file, so they outlive the agent's Bash timeout.
async function detached(label, name, cmd, { clear = [], files = {} } = {}) {
  const b = `${SDIR}/runs/${name}`;
  return must(
    await call(
      `You run one long step of a scripted workflow and wait for it. Do exactly this and nothing else; never do the step's work yourself.
1. Run: mkdir -p ${SDIR}/runs && rm -f ${b}.sh ${b}.log ${b}.exit ${clear.join(" ")}
   Stale files would be read as this run's.
2. With the Write tool, write each file below with exactly the text between its markers, not the markers:
${fileBlocks({ ...files, [`${b}.sh`]: cmd })}
3. Start it detached: nohup sh -c 'sh ${b}.sh > ${b}.log 2>&1; echo $? > ${b}.exit' > /dev/null 2>&1 &
4. Wait for ${b}.exit. Poll in foreground Bash calls of at most 9 minutes each, for example:
   for i in $(seq 1 50); do [ -f ${b}.exit ] && break; perl -e 'select(undef,undef,undef,10)'; done; cat ${b}.exit 2>/dev/null || echo still-running
   Repeat until the exit file exists, for up to 2 hours in total. Never return while the command is still running.
5. Return exitCode: the number in ${b}.exit, or -1 if 2 hours passed without it; and output: the last 60 lines of ${b}.log.`,
      { label, model: "sonnet", effort: "low", schema: SH },
    ),
    label,
  );
}

const SUMMARY =
  'const g=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")),d=g.diff,c=Object.entries(g.checks||{});' +
  "console.log(JSON.stringify({headSha:d.headSha,changedLines:d.changedLines,riskyFiles:d.riskyFiles,deepFiles:d.deepFiles," +
  "passed:g.allChecksPassed===true,checks:c.map(([k])=>k),failing:c.filter(([,v])=>v.exitCode!==0).map(([k])=>k),tests:g.tests," +
  "signals:Object.entries(d.tests.signals).filter(([,v])=>v.length).map(([k])=>k)," +
  "ui:false}))";

let gateRuns = 0;
async function gate(tag) {
  const name = `gate-${++gateRuns}-${tag}`;
  const out = `${SDIR}/${name}.json`;
  const run = await detached(
    `gate ${tag}`,
    name,
    `cd ${WT} && git fetch -q origin && git show origin/main:scripts/gate.mjs > ${GATE} && node ${GATE} --base origin/main --out ${out}`,
    { clear: [out] },
  );
  // A failing check exits 1 with a report; only a gate that did not finish leaves none.
  const r = await sh(`read gate ${tag}`, `node -e ${q(SUMMARY)} ${out}`);
  if (r.exitCode !== 0)
    return {
      passed: false,
      problem: `The gate did not finish (exit ${run.exitCode}). Its log ends:\n${run.output}`,
    };
  let g;
  try {
    // The step runner sometimes appends a line such as "exit=0"; the summary is the last JSON line.
    g = JSON.parse(r.output.trim().split("\n").findLast((l) => l.startsWith("{")) ?? "");
  } catch {
    fail(`gate ${tag} wrote no readable report to ${out}`);
  }
  if (!/^[0-9a-f]{40}$/.test(g.headSha || "")) fail(`gate ${tag} report has no head commit`);
  return {
    ...g,
    problem: g.passed
      ? ""
      : `Failing checks: ${g.failing.join(", ")}. The full report with each check's output tail is ${out}.`,
  };
}

// The gate on a clean tree, with two fix attempts by a fresh Opus.
async function greenGate(tag) {
  let g = await gate(tag);
  for (let i = 1; i <= 2 && !g.passed; i++) {
    collect(
      done(
        await opus(
          `${rules()}\nThe full gate fails on this slice. Find and fix the cause honestly, then commit.\n${g.problem}`,
          `gate fix ${i}`,
          OUTCOME,
        ),
        "gate fix",
      ),
    );
    g = await gate(`${tag}-fix${i}`);
  }
  if (!g.passed) fail(`the gate still fails after two fix attempts. ${g.problem}`);
  return g;
}

async function push(g) {
  await ok(
    "push",
    `cd ${WT} && test "$(git rev-parse HEAD)" = ${g.headSha} && test -z "$(git status --porcelain)" && git push -u origin ${BR} && test "$(git ls-remote origin refs/heads/${BR} | cut -f1)" = ${g.headSha}`,
  );
  pushedGate = g;
}

async function planSet(patch) {
  const js =
    'const fs=require("fs"),[f,id,p]=process.argv.slice(1),plan=JSON.parse(fs.readFileSync(f,"utf8")),s=plan.slices.find((x)=>x.id===id);' +
    'if(!s)process.exit(3);Object.assign(s,JSON.parse(p));fs.writeFileSync(f,JSON.stringify(plan,null,2)+"\\n")';
  await ok(
    `plan: ${S.id} ${patch.state || ""}`,
    `node -e ${q(js)} ${PLAN} ${S.id} ${q(JSON.stringify(patch))}`,
  );
}

// Converts a saved Codex review into findings; a missing or unreadable review fails.
async function convert(file, label, finalOnly = false) {
  const c = must(
    await call(
      `${file} is the saved output of a Codex review. Convert its final review into structured findings. Do not judge, add, merge or drop any.
${
  finalOnly
    ? "- The file holds only Codex's final message (codex exec -o), with no transcript around it."
    : '- The file is a full transcript and can be large: read its end (tail -n 300), widening only if the final message is cut off. The final message follows the last line that is exactly "codex".'
}
- The findings are in the last "Full review comments:" block, or "Review comment:" when there is one. Each entry looks like "- [P1] title — path:lines" followed by its explanation.
- Return severity, file (repository-relative: strip any ${WT}/ or other worktree prefix; use "design" when the entry names no file), line (the first line, if given), title, and scenario (the explanation).
- status "findings" when that block lists findings; "clean" when a final message exists and has no findings block or an empty one (a summary that reports no problems is clean); "missing" only when the file is absent or empty, or the run ended without a final message, for example on an error.`,
      { label, model: "sonnet", effort: "medium", schema: CONVERTED },
    ),
    label,
  );
  if (c.status === "missing" || (c.status === "findings" && !c.findings.length))
    fail(`${label}: no review in ${file}`);
  return c.findings;
}

// ---- Plan
phase("Plan");
const plan = must(
  await opus(
    `Plan or refresh roadmap phase ${PHASE} for delivery as PR slices.${NOTES}
Read files at origin/main, not the working copy of ${REPO}, which may be on another branch: git -C ${REPO} fetch -q origin, then git -C ${REPO} show origin/main:<path> and git -C ${REPO} grep <pattern> origin/main.

If ${PLAN} exists, only refresh it: for each slice with a pr and a state other than "merged", set state "merged" when gh pr view <pr> --json state reports MERGED. Change nothing else, write it back, and return status "ok" with its slices.

Otherwise, plan:
1. Read the phase in docs/roadmap.md, the decision records it touches and the current code. Return status "blocked" with the reason, and write nothing, if a phase it depends on has not shipped or a owner answer it needs is still open.
2. Split it into ordered slices, each independently green and building on merged predecessors, of about ${SLICE_LINES} changed lines or fewer (lockfile and generated files excluded). Cover every in-scope roadmap item; never drop required work to make the phase smaller, and never go beyond the phase.
3. Each slice has: id ("${PHASE}.1", "${PHASE}.2", ...); title; scope; done (checkable done criteria); risky (true when it touches the wire format, signing or keys, the pointer, lock or gc, patches, or storage credentials${RISKY_PHASES.includes(PHASE) ? "; every slice of this phase is risky" : ""}); estLines; and state "pending".
4. mkdir -p ${OUT} and write {"phase": "${PHASE}", "slices": [...]} to ${PLAN}. Return status "ok" with the slices.`,
    "plan",
    PLANNED,
  ),
  "plan",
);
if (plan.status === "blocked") return { phase: PHASE, state: "blocked", reason: plan.reason };

// Slices run in order, and only from "pending" or "handed-back", so a later run does not take over a live worktree.
const next = plan.slices.find((s) => s.state !== "merged");
if (!next) return { phase: PHASE, state: "done" };
const S = WANT ? plan.slices.find((s) => s.id === WANT) : next;
if (!S) return { phase: PHASE, state: "error", reason: `${WANT} is not in ${PLAN}` };
if (S.state === "merged") return { phase: PHASE, slice: S.id, state: "merged", pr: S.pr };
if (S !== next)
  return {
    phase: PHASE,
    slice: S.id,
    state: S.state,
    reason: `${next.id} comes first and is ${next.state}`,
  };
// An auto-merge PR that fell behind main is caught up in this run: merge main, gate, push, re-enable auto-merge.
let CATCH_UP = false;
if (!(S.state === "pending" || (S.state === "handed-back" && WANT === S.id))) {
  if (S.state === "auto-merge" && S.pr) {
    const jq =
      '.state + " " + .mergeStateStatus + (if .autoMergeRequest == null then " PAUSED" else "" end)';
    const st = (
      await sh(
        "check auto-merge",
        `cd ${REPO} && gh pr view ${S.pr} --json state,mergeStateStatus,autoMergeRequest --jq ${q(jq)}`,
      )
    ).output.trim();
    if (!/^OPEN (BEHIND|DIRTY)|^OPEN .* PAUSED$/.test(st))
      return { phase: PHASE, slice: S.id, state: S.state, pr: S.pr, reason: `PR is ${st}` };
    CATCH_UP = true;
  } else
    return {
      phase: PHASE,
      slice: S.id,
      state: S.state,
      pr: S.pr,
      reason: `${S.id} is ${S.state}. A handed-back slice reruns with args.slice; a run that died leaves it in-progress or in-review, so set it to "handed-back" in ${PLAN} first.`,
    };
}

const KEBAB = S.id.toLowerCase().replace(".", "-");
const BR = `phase/${KEBAB}`;
const WT = `${REPO}/.worktrees/${KEBAB}`;
const SDIR = `${OUT}/${KEBAB}`;
const RISKY = S.risky === true || RISKY_PHASES.includes(PHASE);
const TITLE = `${S.id}: ${safe(S.title)}`;
const SHOT_DIR = `${WT}/.agent-output/screenshots`;

// The fixed implementer brief, shared by every agent that changes code.
const rules =
  () => `You work on slice ${S.id} "${safe(S.title)}" of roadmap phase ${PHASE}, in the git worktree ${WT} on branch ${BR}. Work only there; never edit or switch branches in the main checkout ${REPO}.
Scope: ${S.scope}
Done when: ${S.done.join("; ")}${RISKY ? `\nDesign note: ${SDIR}/design.md` : ""}${NOTES}

AGENTS.md and docs/testing.md in the worktree bind you; read them first. In particular:
- Every behaviour change or bug fix has a test. A bug fix has a test you have seen fail on the old code.
- No sleeps, raised timeouts, retries, .only, skips, or mocks of our own code.
- Follow the Dependencies section of AGENTS.md for every new dependency or major bump, and return one line in dependencies for each new dependency you add: "<pkg>@<version>: licence; peers ok; advisories none; alternatives rejected and why".
- Run pnpm format:fix before each commit.
- Write drafts and notes only under ${WT}/.agent-output/, never a shared scratchpad or /tmp.
- Never commit .agent-output/, .env or secrets.
- Never push, merge, force-push, push to main or change repository or GitHub settings; the workflow pushes after its own gate run.
- Leave everything committed, and run the full gate (node ${GATE} --base origin/main) before you return.
- Tide has no user interface: return screensChanged false.
- If the work cannot be done honestly, return outcome "blocked" with the reason.`;

let PR = 0;
let prUrl = "";
let g = null;
let rounds = 0;
let open = [];
const fixed = [];
const rejected = [];
const deps = [];
const followUps = [];
let built = null;
const shots = new Map(); // file name in SHOT_DIR -> caption; a recapture keeps its name
const shotNotes = [];
let screensChanged = false;
let pushedGate = null;
const collect = (r) => {
  deps.push(...(r.dependencies || []));
  for (const x of r.screenshots || []) {
    const f = x.file.replace(/^.*\//, "");
    if (!/^[a-z0-9][a-z0-9._-]*\.(png|gif|mp4|mov|webm)$/.test(f))
      fail(`screenshot ${f} is not a lowercase kebab-case image or video name`);
    shots.set(f, x.caption.replace(/[\]\[#\n]/g, " "));
  }
  if (r.screenshotNote) shotNotes.push(r.screenshotNote);
  if (r.screensChanged) screensChanged = true;
  return r;
};

const isVideo = (f) => /\.(mp4|mov|webm)$/.test(f);

// Writes the PR body with screenshots and videos attached to the description itself; gh rewrites the ./ references,
// a video's to a bare URL that plays inline.
async function publishBody(review) {
  if (screensChanged && !shots.size)
    fail(`a screen changed but no screenshots were attached. ${shotNotes.join(" ")}`);
  const file = `${SDIR}/pr-body.md`;
  const attach = [...shots]
    .map(([f, c]) => `--attach ${q(isVideo(f) ? `./${f}` : `./${f}#${c}`)}`)
    .join(" ");
  await ok(
    "update PR body",
    `mkdir -p ${SHOT_DIR} && cd ${SHOT_DIR} && gh pr edit ${PR} --body-file ${file} ${attach}`,
    { [file]: body(review) },
  );
}

const gateLine = () => {
  const p = pushedGate;
  return `Full gate (scripts/gate.mjs from main) at ${p.headSha}: ${p.checks.join(", ")} pass; ${p.tests?.passed ?? "unknown"} tests passed. ${p.changedLines} changed lines. Risky files: ${p.riskyFiles.join(", ") || "none"}.`;
};
const reviewText = () => `${history.map((h) => h.summary).join("\n")}

**Fixed:**
${bullets(fixed, "none")}

**Rejected:**
${bullets(rejected, "none")}

**Not blocking:**
${bullets(followUps, "none")}`;
const body = (review) => `${built.summary}

## Decisions

${bullets(built.decisions, "None beyond the roadmap and the decision records.")}

## Dependencies

${bullets(deps, "No new dependencies.")}

## Tests

${bullets(built.tests, "None listed.")}

## Gate

${gateLine()}${
  shots.size || shotNotes.length
    ? `\n\n## Screenshots\n\n${[...shots].map(([f, c]) => (isVideo(f) ? `**${c}**\n\n![](./${f})` : `**${c}**\n\n![${c}](./${f})`)).join("\n\n")}${shotNotes.length ? `\n\n${shotNotes.join("\n")}` : ""}`
    : ""
}
${review ? `\n## Review\n\n${review}\n` : ""}
${FOOTER}`;
const history = [];

// Catches the branch up with main (merge, never rebase), gates and pushes it, then auto-merges or labels it.
async function finish() {
  phase("Merge");
  const caught = await ok(
    "merge origin/main if behind",
    `cd ${WT} && git fetch -q origin && if git merge-base --is-ancestor origin/main HEAD; then echo up-to-date; elif git merge --no-edit origin/main; then echo merged-main; else git merge --abort; echo "conflicts with main"; exit 3; fi`,
  );
  const merged = caught.trim().endsWith("merged-main");
  if (merged || !g) {
    if (merged) await ok("install", `cd ${WT} && pnpm install --frozen-lockfile`);
    g = await gate("main");
    if (!g.passed) fail(`the gate fails after merging main. ${g.problem}`);
    // Auto-merge is re-enabled below on the new head only, so GitHub never merges a head this gate did not see.
    if (CATCH_UP && merged)
      await ok("pause auto-merge", `cd ${WT} && gh pr merge ${PR} --disable-auto`);
    if (merged) await push(g);
  }
  if (built) await publishBody(reviewText());
  else if (merged) {
    // A catch-up run did not build the body, so it replaces only the gate line.
    const js =
      'const fs=require("fs"),[f,l]=process.argv.slice(1),b=fs.readFileSync(f,"utf8");' +
      'if(!/## Gate\\n\\n/.test(b))process.exit(3);fs.writeFileSync(f,b.replace(/(## Gate\\n\\n)[^\\n]*/,(m,h)=>h+fs.readFileSync(l,"utf8").trim()))';
    await ok(
      "refresh PR gate line",
      `cd ${WT} && gh pr view ${PR} --json body --jq .body > ${SDIR}/pr-body.md && node -e ${q(js)} ${SDIR}/pr-body.md ${SDIR}/gate-line.txt && gh pr edit ${PR} --body-file ${SDIR}/pr-body.md`,
      { [`${SDIR}/gate-line.txt`]: gateLine() },
    );
  }

  // The owner opted out of approving slices: risky ones get the design note and deep review, then merge like any other.
  let state = "pr-open";
  if (AUTO_MERGE) {
    await ok(
      "auto-merge",
      `cd ${WT} && gh pr merge ${PR} --squash --auto --match-head-commit ${g.headSha}`,
    );
    state = "auto-merge";
  }
  await planSet({ state, headSha: g.headSha, ...(built ? { rounds } : {}) });
  return {
    phase: PHASE,
    slice: S.id,
    pr: prUrl,
    headSha: g.headSha,
    rounds,
    fixed,
    rejected,
    state,
  };
}

try {
  if (CATCH_UP) {
    PR = S.pr;
    prUrl = `https://github.com/HashimTheArab/tide/pull/${S.pr}`;
    await ok(
      "reuse worktree",
      `set -e
git -C ${REPO} fetch -q origin
git -C ${REPO} worktree prune
if [ ! -e ${WT} ]; then
  if git -C ${REPO} show-ref --verify --quiet refs/heads/${BR}; then git -C ${REPO} worktree add ${WT} ${BR}; else git -C ${REPO} worktree add -b ${BR} ${WT} origin/${BR}; fi
fi
mkdir -p ${SDIR}/runs ${OUT}/trusted
cd ${WT} && test -z "$(git status --porcelain)" && git merge -q --ff-only origin/${BR}
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/${BR})"
pnpm install --frozen-lockfile`,
    );
    return await finish();
  }
  await planSet({ state: "in-progress", branch: BR });
  await ok(
    "set up worktree",
    `set -e
git -C ${REPO} fetch -q origin
if git -C ${REPO} ls-remote --exit-code --heads origin ${BR} > /dev/null; then echo "${BR} exists on origin; close its PR and delete the branch to rerun ${S.id}"; exit 3; fi
if [ -e ${WT} ]; then git -C ${REPO} worktree remove --force ${WT}; fi
git -C ${REPO} worktree prune
if git -C ${REPO} show-ref --verify --quiet refs/heads/${BR}; then git -C ${REPO} branch -D ${BR}; fi
rm -rf ${SDIR} && mkdir -p ${SDIR}/runs ${OUT}/trusted
git -C ${REPO} worktree add -b ${BR} ${WT} origin/main
git -C ${REPO} show origin/main:scripts/gate.mjs > ${GATE}
cd ${WT} && pnpm install --frozen-lockfile`,
  );

  // ---- Design note, risky slices only
  let advice = "";
  // Design P1s left after the closure check, other than a smaller design: the build must meet them and round 1 checks.
  let designMust = [];
  if (RISKY) {
    phase("Design");
    done(
      await opus(
        `${rules()}\nBefore any code, read the code this slice touches and write the design note ${SDIR}/design.md: the approach, data model, invariants, failure and concurrency cases, and the planned tests. Keep it short. Do not change code or run the gate yet.`,
        "design note",
        OUTCOME,
      ),
      "design note",
    );
    const review = async (n, prior = []) => {
      const file = `${SDIR}/design-review-${n}.md`;
      const prompt = `${SDIR}/runs/design-review-${n}.prompt.md`;
      const run = await detached(
        `codex design review ${n}`,
        `design-review-${n}`,
        `cd ${WT} && codex exec --sandbox read-only ${SOL} -C ${WT} -o ${file} - < ${prompt}`,
        {
          clear: [file],
          files: {
            [prompt]: `Review the design note ${SDIR}/design.md for slice ${S.id} "${safe(S.title)}" of roadmap phase ${PHASE}, before any code is written. Do not edit anything.
Scope: ${S.scope}
Done when: ${S.done.join("; ")}
The rules are AGENTS.md, docs/design.md, docs/decisions/ and docs/testing.md in this repository; the phase is in docs/roadmap.md. Read the code the design touches.${DECISIONS}
Report real problems only: a wrong or unsafe approach, missed invariants, failure or concurrency cases, missing tests, decision-record violations, or a dependency that fails the AGENTS.md rules. Severity: P0 builds the wrong thing or loses data; P1 a design-level gap the slice would ship (wrong approach, missing requirement or test case, broken invariant, decision-record or dependency-rule violation); P2 a concrete weakness, including any code-level detail the build and gate will exercise (import paths, call forms, test plumbing, fixture data, cleanup order), which the builder receives as instructions; P3 a nit.
Also answer: is there a materially smaller design? Report it as a P1 titled "Smaller design" only if it removes a component, dependency or piece of state; a rearrangement of tests or code within the same design is a P2.${prior.length ? `\nThis is a closure check of a revised note. A finding below is resolved when its own failure scenario, as written below, can no longer happen under the revised note; keep its severity only if that exact scenario still can. A broader, deeper or different scenario, even under the same title, is a new finding: report it as P2 unless it is a P0.\n${prior.map((f) => `- [${f.severity}] ${f.title}: ${f.scenario}`).join("\n")}` : ""}
End your final message with the line "Full review comments:" followed by one line per finding, "- [P1] <title> — <detail>", or the line "No findings." if there are none.`,
          },
        },
      );
      if (run.exitCode !== 0)
        fail(`codex design review exited ${run.exitCode}: ${run.output.slice(-800)}`);
      return convert(file, `convert design review ${n}`, true);
    };
    let found = await review(1);
    if (found.some((f) => sev[f.severity] <= 1)) {
      done(
        await opus(
          `${rules()}\nCodex reviewed ${SDIR}/design.md (raw review: ${SDIR}/design-review-1.md). Revise the note to resolve these findings, or state in it with evidence why one is wrong. Do not change code or run the gate yet.\n${found.map((f) => `- [${f.severity}] ${f.title}: ${f.scenario}`).join("\n")}`,
          "design revision",
          OUTCOME,
        ),
        "design revision",
      );
      found = await review(
        2,
        found.filter((f) => sev[f.severity] <= 1),
      );
      const left = found.filter((f) => sev[f.severity] <= 1);
      const hard = left.filter((f) => f.severity === "P0" || /smaller design/i.test(f.title));
      if (hard.length)
        fail(
          `the design review still has P0 or smaller-design problems: ${hard.map((f) => `[${f.severity}] ${f.title}`).join("; ")}`,
        );
      designMust = left;
    }
    const rest = found.filter((f) => !designMust.includes(f));
    if (designMust.length)
      advice += `\nRequired: the design review left these unresolved, and the build must meet each one; the first deep review checks them:\n${designMust.map((f) => `- [${f.severity}] ${f.title}: ${f.scenario}`).join("\n")}`;
    if (rest.length)
      advice += `\nNon-blocking design review points; apply those that keep the slice simple:\n${rest.map((f) => `- [${f.severity}] ${f.title}: ${f.scenario}`).join("\n")}`;
  }

  // ---- Build
  phase("Build");
  built = done(
    await opus(
      `${rules()}${advice}
Build the slice: code, tests and the docs it needs. Keep the diff to this slice; later slices exist. Commit in logical commits.
Return, for the PR body: summary (a few markdown bullet lines on what you built), decisions (choices a reviewer should know, each with its reason), dependencies (one line per new dependency, or empty), and tests (the tests that prove the done criteria, and what each proves).`,
      "build",
      BUILT,
    ),
    "build",
  );
  collect(built);
  g = await greenGate("build");
  if (!g.changedLines) fail("the build changed nothing");
  if (g.ui && built.screensChanged !== true && !shotNotes.length)
    fail(
      "the slice touches user-facing code but neither reported its screens nor said why none changed",
    );
  await push(g);
  // The PR opens with a placeholder body; publishBody then writes it with the screenshots.
  const created = await ok(
    "open PR",
    `cd ${WT} && gh pr create --base main --head ${BR} --title ${q(TITLE)} --body ${q(`Opening ${S.id}; the description follows.`)}`,
  );
  const m = /https:\/\/github\.com\/\S+\/pull\/(\d+)/.exec(created);
  if (!m) fail(`gh pr create printed no PR URL: ${created.slice(-300)}`);
  prUrl = m[0];
  PR = Number(m[1]);
  await planSet({ state: "in-review", pr: PR });
  await publishBody("");

  // ---- Review rounds
  phase("Review");
  const codexReview = async (r, base) => {
    const file = `${SDIR}/codex-review-${r}.md`;
    const run = await detached(
      `codex review r${r}`,
      `codex-review-${r}`,
      `cd ${WT} && git fetch -q origin && codex review --base ${base} -c model="gpt-6.2-sol" -c model_reasoning_effort="high" < /dev/null > ${file} 2>&1`,
      { clear: [file] },
    );
    if (run.exitCode !== 0) fail(`codex review r${r} exited ${run.exitCode}; see ${file}`);
    return convert(file, `convert codex review r${r}`);
  };
  const deepWhy = (r) =>
    [
      r === 1 && RISKY && "risky slice",
      r === 1 && designMust.length > 0 && "design-gate requirements",
      g.changedLines > DEEP_LINES && `${g.changedLines} changed lines`,
      g.riskyFiles.length && `risky files: ${g.riskyFiles.slice(0, 10).join(", ")}`,
      g.deepFiles.length &&
        `routers, validators or repositories: ${g.deepFiles.slice(0, 10).join(", ")}`,
      g.signals.length && `test signals in the gate report: ${g.signals.join(", ")}`,
    ].filter(Boolean);
  const deepReview = async (r, base, why) =>
    must(
      await opus(
        `You are a deep reviewer in fresh context, and read-only: never edit, commit or push, and leave git status clean. You did not build this slice; read the code, not anyone's account of it.
Slice ${S.id} "${safe(S.title)}" of roadmap phase ${PHASE}, in the worktree ${WT}.
Scope: ${S.scope}
Done when: ${S.done.join("; ")}
Review git diff ${base}...HEAD${r > 1 ? " (the fixes since the last review), reading git diff origin/main...HEAD for context" : ""}. You were triggered by: ${why.join("; ")}.${r === 1 && designMust.length ? `\nThe design review left these requirements for the build. Report each one the code does not meet as P1: ${designMust.map((f) => `${f.title} (${f.scenario})`).join("; ")}` : ""}
The rules are AGENTS.md, docs/design.md, docs/decisions/ and docs/testing.md.${DECISIONS}${history.length ? `\nEarlier rounds and how each finding was settled:\n${history.map((h) => h.text).join("\n")}\nRaise a rejected finding again only with new evidence.` : ""}
Report real problems only: correctness, security, data loss, races, idempotency, failure handling, decision-record violations, tests the testing standard rejects, dependency rule failures, needless complexity. Each finding needs file, line and a concrete failure scenario. Severity: P1 a real bug, security gap or data risk; P2 a concrete correctness, test or design problem; P3 a nit. An empty list is a valid answer.`,
        `deep review r${r}`,
        DEEP,
      ),
      "deep review",
    ).findings;
  // Once per slice, before any bug review: the bug reviewers then read the simpler code.
  const simplicityReview = async () =>
    must(
      await opus(
        `You are a simplicity reviewer in fresh context, and read-only: never edit, commit or push, and leave git status clean. You did not build this slice; read the code, not anyone's account of it.
Slice ${S.id} "${safe(S.title)}" of roadmap phase ${PHASE}, in the worktree ${WT}; the change is git diff origin/main...HEAD.
Scope: ${S.scope}
The rules are AGENTS.md, docs/design.md and docs/decisions/. If the simplifying-overgrown-diffs skill is available, apply it.${DECISIONS}
Ask whether this is the smallest, clearest design and code that meets the scope. Report:
- P1 "Smaller design": a materially smaller design that removes a component, dependency, option or piece of state. Only this blocks.
- P2, applied as instructions: duplication or parallel lists kept in sync by hand; a new helper where an existing one would do; code the change replaces but leaves behind; dead code; an abstraction or option with one user; needless indirection; code in a file that does not own what it depends on; comments that restate the code or run past two lines; unclear names; a diff out of proportion to the behaviour.
- P3: a nit.
Do not report bugs, tests or style the formatter owns; other reviewers cover those. Each finding needs file, line and the concrete simpler replacement in scenario. Report only changes that make the code genuinely smaller or clearer, never churn.`,
        "simplicity review",
        DEEP,
      ),
      "simplicity review",
    ).findings;
  const arbiter = (f, d) =>
    opus(
      `You are an independent arbiter in fresh context, and read-only: you may run tests, but never edit, commit or push, and leave git status clean.
Slice ${S.id} of roadmap phase ${PHASE}, in the worktree ${WT}.
A reviewer raised: ${JSON.stringify(f)}
The implementer rejected it: ${d.reason}
${DECISIONS}
Check the code yourself. Your default is "finding-stands"; return "rejection-valid" only if the code shows the rejection is right.`,
      `arbiter ${f.id}`,
      VERDICT,
    );
  const closure = (claims, r) =>
    opus(
      `You check claimed fixes in fresh context, and read-only in ${WT}: never edit, commit or push there, and leave its git status clean.
Slice ${S.id} of roadmap phase ${PHASE}. Each claim's "before" is the commit the finding was raised on; its fix is git diff <before>...HEAD.
Claimed fixes: ${JSON.stringify(claims)}
For each id, decide from the code at HEAD whether the finding is resolved, and run its named test on both versions. Use a throwaway copy: git -C ${WT} worktree add --detach ${REPO}/.worktrees/${KEBAB}-closure-${r} HEAD and pnpm install there; run the test at HEAD and see it pass, then check out the non-test files from "before", run it again, and remove the copy when done (git -C ${REPO} worktree remove --force ${REPO}/.worktrees/${KEBAB}-closure-${r}).
The old-code run must fail on an assertion about the reported behaviour, not on import, setup or a missing export.
Return closed false, with the reason, when the finding is not resolved, the test does not pass at HEAD, or a test was possible but none fails that way on the old code. Return one result per id.`,
      `closure check r${r}`,
      CLOSURE,
    );

  // ---- Simplify: a smaller design must be built or refuted; every other point reaches the simplifier as an instruction.
  let carried = [];
  const sp = must(await simplicityReview(), "simplicity review").map((f, i) => ({
    ...f,
    id: `S.${i + 1}`,
    by: "simplicity review",
    before: g.headSha,
  }));
  if (sp.length) {
    const sx = done(
      await opus(
        `${rules()}
A simplicity review of the whole slice found the points below. Apply them now, before the bug reviews start.
- P1 "Smaller design": implement it, or reject it with concrete evidence that it is wrong or not smaller.
- P2 and P3: apply each one that makes the code smaller or clearer; reject one only with a one-line reason.
Behaviour must not change: every existing test still passes, and a removed test is replaced by one covering the same behaviour. Commit your changes. Return exactly one disposition per id.
${JSON.stringify(sp, null, 1)}`,
        "simplify",
        FIXED,
      ),
      "simplifier",
    );
    collect(sx);
    const by = new Map(sx.dispositions.map((d) => [d.id, d]));
    const missed = sp.filter((f) => !by.has(f.id));
    if (missed.length) fail(`the simplifier did not answer ${missed.map((f) => f.id).join(", ")}`);
    if (sp.some((f) => by.get(f.id).action === "fixed")) {
      g = await greenGate("simplify");
      await push(g);
    }
    for (const f of sp) {
      const d = by.get(f.id);
      if (d.action === "fixed") fixed.push(`${brief(f)} (simplified)`);
      else if (f.severity !== "P1") followUps.push(`${brief(f)}: not applied, ${d.reason}`);
      else {
        const v = must(await arbiter(f, d), `arbiter ${f.id}`);
        if (v.verdict === "finding-stands") carried.push({ ...f, mustFix: true, arbiter: v.reason });
        else rejected.push(`${brief(f)}: ${d.reason} (arbiter agreed: ${v.reason})`);
      }
    }
    history.push({
      summary: `Simplify: ${sp.length} findings; ${sp.filter((f) => by.get(f.id).action === "fixed").length} applied.`,
      text: `Simplify: ${sp.map((f) => `${brief(f)} ${by.get(f.id).action}: ${by.get(f.id).reason}`).join("; ")}`,
    });
  } else history.push({ summary: "Simplify: no findings.", text: "Simplify: no findings" });

  let base = "origin/main";
  let head = g.headSha;
  let simpler = "";
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    rounds = r;
    const why = deepWhy(r);
    const [cx, dp] = await Promise.all([
      codexReview(r, base),
      why.length ? deepReview(r, base, why) : Promise.resolve(null),
    ]);
    const found = [
      ...carried,
      ...cx.map((f, i) => ({ ...f, id: `C${r}.${i + 1}`, by: "Codex", before: head })),
      ...(dp || []).map((f, i) => ({
        ...f,
        id: `D${r}.${i + 1}`,
        by: "deep review",
        before: head,
      })),
    ];
    open = found.filter((f) => f.mustFix || blocking(f, r));
    followUps.push(...found.filter((f) => !f.mustFix && !blocking(f, r)).map(brief));
    const entry = {
      text: "",
      summary: `Round ${r} (${base.slice(0, 12)}..${head.slice(0, 12)}): Codex ${cx.length} findings; deep review ${dp ? `${dp.length} findings` : "not triggered"}; ${open.length} blocking.`,
    };
    history.push(entry);
    entry.text = `Round ${r}: ${found.map(brief).join("; ") || "no findings"}`;
    log(`${S.id} round ${r}: ${open.length} blocking of ${found.length}`);
    if (!open.length || r === MAX_ROUNDS) break;

    if (r === 2) {
      const s = must(
        await opus(
          `You are a simplification reviewer in fresh context, and read-only: never edit, commit or push.
Slice ${S.id} "${safe(S.title)}" of roadmap phase ${PHASE}, in the worktree ${WT}; the change is git diff origin/main...HEAD.
Two review rounds have not converged. Open findings: ${JSON.stringify(open)}
Review history:\n${history.map((h) => h.text).join("\n")}
Is there a materially smaller design that removes these bug classes by construction? Answer "simplify" with that design, described concretely enough to implement, or "patch" if the current design is right and the findings are ordinary fixes.`,
          "simplification review",
          SIMPLER,
        ),
        "simplification review",
      );
      log(`simplification review: ${s.verdict}`);
      if (s.verdict === "simplify") simpler = s.design;
    }

    const fx = done(
      await opus(
        `${rules()}
Review round ${r} left these blocking findings (the raw Codex review is ${SDIR}/codex-review-${r}.md):
${JSON.stringify(open, null, 1)}
${simpler ? `A simplification review found a materially smaller design that removes these bug classes. Implement it instead of patching, and answer each finding against it:\n${simpler}\n` : ""}${carried.length ? `${carried.map((f) => f.id).join(", ")} were upheld by an arbiter or failed a closure check; you must fix them.\n` : ""}For each id, verify the finding against the code yourself.
- Real: fix it with a test that fails on the old code. Prove that by reverting the fix, running the test to see it fail, and restoring the fix.
- Not real: reject it with concrete evidence.
Accepting everything and rejecting everything are both red flags. Commit your changes. Return exactly one disposition per id, naming the test for each fix.`,
        `fix r${r}`,
        FIXED,
      ),
      "fixer",
    );
    simpler = "";
    collect(fx);
    const by = new Map(fx.dispositions.map((d) => [d.id, d]));
    const missed = open.filter((f) => !by.has(f.id));
    if (missed.length) fail(`the fixer did not answer ${missed.map((f) => f.id).join(", ")}`);
    const claims = open.filter((f) => by.get(f.id).action === "fixed");
    const disputed = open.filter((f) => by.get(f.id).action === "rejected");
    const again = disputed.filter((f) => f.mustFix);
    if (again.length)
      fail(
        `${again.map((f) => f.id).join(", ")} rejected after an arbiter upheld them or a fix was claimed`,
      );

    // Claimed fixes get a closure check and rejections an arbiter, both on the gated, pushed code.
    g = await greenGate(`r${r}`);
    await push(g);
    const [checked, ...verdicts] = await Promise.all([
      claims.length
        ? closure(
            claims.map((f) => ({ ...f, test: by.get(f.id).test || "none named" })),
            r,
          )
        : Promise.resolve({ results: [] }),
      ...disputed.map((f) => arbiter(f, by.get(f.id))),
    ]);
    const results = new Map(must(checked, "closure check").results.map((c) => [c.id, c]));
    carried = [];
    for (const f of claims) {
      const c = results.get(f.id) || fail(`the closure check skipped ${f.id}`);
      if (c.closed) fixed.push(`${brief(f)} (test: ${by.get(f.id).test || "none named"})`);
      else carried.push({ ...f, mustFix: true, closure: c.reason });
    }
    disputed.forEach((f, i) => {
      const v = must(verdicts[i], `arbiter ${f.id}`);
      if (v.verdict === "finding-stands") carried.push({ ...f, mustFix: true, arbiter: v.reason });
      else rejected.push(`${brief(f)}: ${by.get(f.id).reason} (arbiter agreed: ${v.reason})`);
    });
    entry.text += `\nSettled: ${open.map((f) => `${f.id} ${by.get(f.id).action}: ${by.get(f.id).reason}`).join("; ")}${carried.length ? `; still open after the closure check or arbiter: ${carried.map((f) => f.id).join(", ")}` : ""}`;
    base = head;
    head = g.headSha;
  }
  if (open.length)
    fail(`${open.length} blocking findings still open after ${rounds} review rounds`);

  return await finish();
} catch (e) {
  if (!(e instanceof HandBack)) throw e;
  const reason = e.message;
  log(`${S.id} handed back: ${reason}`);
  try {
    await planSet({ state: "handed-back", reason: reason.slice(0, 2000), pr: PR || undefined });
    if (PR) {
      await ok(
        "hand back on the PR",
        `cd ${WT} && ${LABEL} && gh pr edit ${PR} --add-label needs-owner && gh pr comment ${PR} --body-file ${SDIR}/hand-back.md`,
        {
          [`${SDIR}/hand-back.md`]: `The delivery loop handed this slice back after ${rounds} review rounds.

**Reason:** ${reason}

**Open findings:**
${bullets(
  open.map((f) => `${brief(f)}: ${f.scenario}`),
  "none",
)}

**Fixed so far:**
${bullets(fixed, "none")}

**Rejected:**
${bullets(rejected, "none")}

${FOOTER}`,
        },
      );
      // Refreshed last, so dependency lines and screenshots from pushed fixes reach the owner.
      if (built && pushedGate) await publishBody(reviewText());
    }
  } catch (e2) {
    if (!(e2 instanceof HandBack)) throw e2;
    log(`recording the hand-back failed: ${e2.message}`);
  }
  return {
    phase: PHASE,
    slice: S.id,
    pr: prUrl || null,
    headSha: g?.headSha || null,
    rounds,
    fixed,
    rejected,
    state: "handed-back",
    reason,
  };
}
