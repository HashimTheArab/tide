---
status: decided
updated: 2026-11-21
---

# Delivery loop

How a roadmap phase becomes merged PRs, one slice per run, with no owner approval: the owner opted out of reviewing slices. The loop is the
named workflow `.claude/workflows/implement-phase.js`. Opus plans, builds and fixes; Codex (`gpt-6.2-sol`, high
effort) and fresh Opus agents review. Plain code in the script decides every branch; agents only do the steps.

Branch protection on `main` requires the `check` job, which passes only when the `gate` job (`scripts/gate.mjs`)
passed, on an up-to-date branch. Admins can
override it. Agents are denied admin merges, force pushes, pushes to `main` and settings changes by
`.claude/settings.json`.

## Running it

Run `implement-phase` with `{phase: "P2"}` from the Tide checkout or one of its worktrees; the run finds the main
checkout through git. Its path may hold only letters, digits, `.`, `_`, `-` and `/`; the run stops on any other
path, since agents put it into shell commands unquoted. Each run delivers one slice: the one you name, or the next
pending one. Run it again for the next slice. Progress lives in `.agent-output/phases/<phase>/plan.json`, and each
slice's evidence (design note, gate reports, Codex reviews, PR body) in `.agent-output/phases/<phase>/<slice>/`.
Always start a fresh run; never use `resumeFromRunId`, which replays stale evidence.

| Argument | Default | Meaning |
| --- | --- | --- |
| `phase` | required | Roadmap phase, e.g. `"P2"` |
| `slice` | next pending | Run this slice, e.g. `"P2.3"`, including one that was handed back |
| `notes` | none | Extra instructions for this run's agents |
| `maxRounds` | 3 | Review rounds before handing back (1 to 5) |
| `deepReviewLines` | 400 | Changed lines that trigger the deep review (50 to 5000) |
| `sliceLines` | 400 | Target size of a planned slice (100 to 3000) |
| `autoMerge` | true | Auto-merge a clean slice through GitHub |

## What runs

1. **Plan (Opus).** On the first run it reads the roadmap phase, its decision records and the code, and writes
   `plan.json`: ordered slices of about `sliceLines` lines or fewer, each with a scope, done criteria, a line estimate
   and a `risky` flag. A slice is risky when it touches the wire format, signing or keys, the pointer, lock or gc, patches, or storage
   credentials, and every slice of P2 to P5 is risky. Later runs only mark slices whose PRs merged.
   Slices run in order: if the first unmerged slice is still waiting on its PR, the run stops and reports the
   PR's state. If that PR is set to auto-merge but has fallen behind `main`, conflicts with it, or had auto-merge
   paused by an interrupted catch-up, the run catches it up as in step 7 instead, so parallel streams need no
   manual update.
2. **Design note (risky slices only).** The implementer writes `design.md`: approach, data model, invariants,
   failure and concurrency cases, and planned tests. Codex reviews it read-only and is asked whether a materially
   smaller design exists. One revision is allowed; the second review only checks whether each
   finding's own failure scenario is gone (broader or new scenarios are P2 instructions unless P0), and a P0 or a
   "smaller design" P1 left after it hands back. Any other P1 left becomes a build requirement that the first
   deep review checks and reports as P1 if unmet.
3. **Build (Opus).** The slice is built in its own worktree, `.worktrees/<slice>`, on branch `phase/<slice>` off
   `origin/main`, under a fixed brief: AGENTS.md, the testing standard, the dependency rules, a test for every
   behaviour change, and a test seen failing on the old code for every fix. Then the full gate runs on a clean
   tree, with two fix attempts before handing back. The workflow pushes and opens the PR, whose body covers what
   was built, the decisions, one line per new dependency, the tests and the gate result.
4. **Simplify (fresh Opus).** Before any bug review, a read-only Opus reviews the whole diff for the smallest,
   clearest design: a materially smaller design (fewer components, dependencies, options or state) is the only
   blocking finding; duplication, a new helper where one exists, leftover replaced code, single-use abstractions,
   misplaced code, long comments and unclear names go to a fresh Opus simplifier as instructions. A smaller design
   it rejects goes to the arbiter and, if upheld, must be fixed in round 1. The gate runs again before review.
5. **Review rounds.** Each round runs `codex review` against `origin/main` in round 1, and against the previous
   round's head afterwards, saving the output as `codex-review-<round>.md`. A fresh, read-only Opus deep review
   runs alongside it on a risky slice's first round, or when the slice has more than `deepReviewLines` changed
   lines, touches risky files or any server or CLI source, or the gate reports test signals
   (skips, retries, mocks, sleeps). A missing or empty review hands back; it never counts as clean.
6. **Fix (fresh Opus).** It checks every blocking finding against the code, fixes the real ones with a test it
   has seen fail on the old code, and rejects the rest with evidence. The gate runs again, with the same two fix
   attempts, and the workflow pushes. A fresh Opus then checks each claimed fix: its test must pass now and fail
   on the commit the finding was raised on, on the reported behaviour rather than on setup. A fresh Opus
   arbiter, whose default is that the finding stands, judges each rejection. A fix that fails its check, or an
   upheld finding, must be fixed next round whatever its severity, and cannot be rejected again.
7. **Convergence.** P0 and P1 findings always block, P2 blocks in rounds 1 and 2, and P3 never blocks. If round 2
   still has blocking findings, a fresh Opus asks whether a materially smaller design would remove those bug
   classes; if so, the next fix implements that design instead of patching.
8. **Merge.** If the branch is behind `main`, the workflow merges `origin/main` into it in the slice's worktree
   (never a rebase, force push or `gh pr update-branch`), re-runs the trusted gate on the merged head and pushes
   only if it passes; a conflict or a failing gate hands back. Auto-merge is paused before that push and
   re-enabled on the new head, so nothing reaches `main` without passing both the trusted gate and CI. It updates the PR body with the review history and sets auto-merge on the exact head
   commit, unless `autoMerge` is false. Risky slices merge the same way; their extra safety is the design note and
   deep review.

## When it stops

- A slice is handed back: the design review left a P0 or P1, the gate still fails after two fixes, findings are
  still blocking after `maxRounds`, the fixer rejects a finding the arbiter upheld or it already claimed fixed, the branch conflicts with
  `main`, or any step crashed or returned no evidence. The reason is in `plan.json`; if the PR exists it gets
  `needs-owner` and a comment listing what is open. Rerun with `slice` once the cause is dealt with; an open PR
  must be closed and its branch deleted first.
- A run that died leaves its slice `in-progress` or `in-review`. Set it to `handed-back` in `plan.json` to rerun
  it. Do not start two runs of the same phase at once; a later run would take over the earlier one's worktree.

## Rules

- **Missing evidence is never success.** A crashed step, an empty review, an unanswered finding or a git error
  hands back.
- **The gate cannot be graded by the branch.** Every gate run uses a copy of `scripts/gate.mjs` taken from
  `origin/main`. Its risky and deep-review path lists live there; changing them is itself risky.
- **Reviewers are Codex and Opus only.** Cursor Bugbot and CodeRabbit are not part of the loop.
- **Phases touching the protocol or storage layout run one at a time.** Other phases may run in parallel.
