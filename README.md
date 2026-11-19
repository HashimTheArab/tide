# Tide

**A serverless Expo Updates server for Cloudflare Workers or any container.**

> Status: in development. Not ready for production use.

Tide serves over-the-air updates to apps that use the stock `expo-updates` library:

- **Signed at publish.** The CLI signs manifests; the server only serves stored bytes and never holds a key.
- **Read-only server.** No dashboard, publish API or database on the public internet.
- **Bundle diffing without a database.** bsdiff patches, including from the bundle built into the app.
- **One codebase, two runtimes.** The same Hono app runs on Cloudflare Workers or Node, on R2 or S3-compatible
  storage.

See [docs/design.md](docs/design.md) for how it works and [docs/roadmap.md](docs/roadmap.md) for what is built.

## Development

Requires Node 26 and pnpm 12.

```sh
pnpm install
pnpm gate        # every check CI runs, as JSON
```

## License

[MIT](LICENSE)
