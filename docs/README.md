# Docs

Start here; keep this index current when adding a doc.

## Conventions

- Front matter on every doc: `status` (`draft`, `decided` or `superseded`) and `updated` (ISO date).
- A choice becomes binding only as a record in `decisions/` (`0001-title.md`): decision, why, rejected options and
  when to revisit. Changing a decided choice needs a new or superseding record in the same PR.
- Agent working output (reports, reviews, plans) goes in the gitignored `.agent-output/`, never here.
- `pnpm docs:check` (in the gate) fails on unindexed docs, missing front matter and stray files.

## Index

- [Design](design.md): draft, how Tide serves, signs and patches updates
- [Roadmap](roadmap.md): draft, the phases that build the design
- [Testing standard](testing.md): decided, what to test and what reviewers reject
- [Deploying](deploy.md): draft, an operator's Worker, staging and production, and the container
- [Delivery loop](delivery-loop.md): decided, how a roadmap phase goes from plan to merge
- [Releasing](release.md): draft, the one-time npm setup, the checks before each release and the tag that publishes
- [Comparison sources](comparison.md): draft, the sources behind the README comparison table

Decisions:

- [0001 Architecture](decisions/0001-architecture.md)
