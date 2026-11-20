# The Node entry. Build from the repository root: docker build -f packages/server/Dockerfile .
# Storage and every credential come from the run-time environment; docs/deploy.md lists the variables.

FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /app
# The context is only the files Dockerfile.dockerignore names; the root .dockerignore admits none to other builders.
COPY . .
RUN npm install --global --no-fund --no-audit "$(node -p 'require("./package.json").packageManager')" \
  && pnpm install --frozen-lockfile --prod --ignore-scripts --filter @tide/server...

FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 8787
CMD ["node", "packages/server/src/node.ts"]
