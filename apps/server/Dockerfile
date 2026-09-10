FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
# One install, from the lockfile, with lifecycle scripts off. A `|| npm install`
# fallback would quietly resolve a drifted lockfile fresh from the registry,
# which is the one thing a lockfile exists to prevent, and a later install with
# scripts enabled would undo --ignore-scripts: nothing here needs a postinstall,
# since the image gets ffmpeg from apt and ffmpeg-static's download is dead
# weight. Dev dependencies come along because tsc needs them, and are pruned
# below rather than shipped.
RUN npm ci --workspace apps/server --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build --workspace apps/server \
 && npm prune --omit=dev --workspace apps/server --include-workspace-root --ignore-scripts

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8787 TMP_DIR=/tmp/tvsham
WORKDIR /app
# Only what the server runs: the compiled output, the shared package it imports,
# and the pruned production dependencies. typescript, tsx and the rest of the
# dev tree have no business in a container that decodes uploaded video.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/shared ./packages/shared
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
RUN mkdir -p /tmp/tvsham && chown node:node /tmp/tvsham
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "apps/server/dist/index.js"]
