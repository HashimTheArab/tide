# Contributing

Thanks for helping. Tide serves code to installed apps, so correctness comes first and every change goes through the
same checks.

## Before you start

- Read [AGENTS.md](AGENTS.md). It holds the principles, layout and rules that people and AI agents follow alike.
- Read [docs/testing.md](docs/testing.md) before writing or reviewing a test.
- [docs/README.md](docs/README.md) indexes the design, roadmap and decision records. Changing a decided choice needs a
  new or superseding record in `docs/decisions/` in the same pull request.
- Open an issue first for anything larger than a small fix. Report security problems privately, as
  [SECURITY.md](SECURITY.md) describes.

## Making a change

Requires the Node and pnpm versions in `engines` in [package.json](package.json), and
[Betterleaks](https://github.com/betterleaks/betterleaks) for the secrets check.

```sh
pnpm install
pnpm format:fix  # oxfmt formats and orders imports
pnpm gate        # every check CI runs, as JSON; commit first, it refuses a dirty tree
```

A pull request is ready when `pnpm gate` reports `"allChecksPassed": true`. `pnpm test:container` (needs Docker) and
`pnpm conformance` are not part of the gate; run them when you change the image or what clients see.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
