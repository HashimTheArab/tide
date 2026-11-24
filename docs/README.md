# Docs

## Index

Using Tide:

- [Getting started](getting-started.md): a server, an app and a first update
- [Deploying](deploy.md): an operator's Worker, staging and production, and the container
- [Operating Tide](agents.md): which command answers a question and which acts on it, for people and agents
- [Design](design.md): how Tide serves, signs and patches updates, and every command's rules

Working on Tide:

- [Roadmap](roadmap.md): the phases that build the design
- [Testing standard](testing.md): what to test and what reviewers reject
- [Delivery loop](delivery-loop.md): how a roadmap phase goes from plan to merge
- [Releasing](release.md): the one-time npm setup, the checks before each release and the tag that publishes
- [Comparison sources](comparison.md): the sources behind the README comparison table

Decisions:

- [0001 Architecture](decisions/0001-architecture.md)
- [0002 Hermes delta compiles](decisions/0002-hermes-delta-compiles.md)
- [0003 One signing identity per runtime](decisions/0003-one-identity-per-runtime.md)

## Conventions

- Front matter on every doc: `status` (`draft`, `decided` or `superseded`) and `updated` (ISO date).
- A choice becomes binding only as a record in `decisions/` (`0001-title.md`): decision, why, rejected options and
  when to revisit. Changing a decided choice needs a new or superseding record in the same PR.
- Agent working output (reports, reviews, plans) goes in the gitignored `.agent-output/`, never here.
- `pnpm docs:check` (in the gate) fails on unindexed docs, missing front matter and stray files.
