# The API as a container, built from the monorepo root.
#
# BUILD CONTEXT IS THE REPO ROOT, NOT apps/api.
# The API depends on five workspace packages whose `main` fields point at `./dist`,
# so they have to be present AND built before it can start. A context of apps/api
# would contain none of them.
#
# WHY NODE, NOT tsx.
# Everywhere else the API runs through tsx (`node --import tsx src/main.ts`), which is
# a devDependency and therefore absent from a production install. It does not need to
# be here: every relative import in the source already carries a `.js` extension, so
# the compiled ESM in `dist` resolves under plain node with no loader.

# syntax=docker/dockerfile:1

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
# `...` means "and everything it depends on". The web and mobile apps are never
# installed — no Cesium, no Expo — but their package.json files are still present,
# because --frozen-lockfile validates the lockfile against the whole workspace and
# fails if a member is missing.
RUN pnpm install --frozen-lockfile --filter "@orbitwatch/api..."
RUN pnpm --filter "@orbitwatch/api..." run build
# Drops devDependencies now that nothing else needs compiling. The workspace links
# survive as links to the dist output built above.
RUN pnpm install --frozen-lockfile --prod --filter "@orbitwatch/api..."

FROM base AS runtime
ENV NODE_ENV=production
# Bound below the container's memory limit, so V8 reclaims rather than being killed by
# the OOM reaper. /catalog/elements is a ~7 MB response that is parsed and compressed
# in memory, which is the one allocation here worth thinking about.
ENV NODE_OPTIONS=--max-old-space-size=384
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/api

# Not root. Nothing here needs to write to the image.
USER node

EXPOSE 3333
CMD ["node", "dist/main.js"]
