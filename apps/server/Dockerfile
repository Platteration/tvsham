FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
# One install, from the lockfile, with lifecycle scripts off. The lockfile is
# copied by name, not as `package-lock.json*`, so a build context without one
# stops at the COPY above. A `|| npm install` fallback would quietly resolve a
# drifted lockfile fresh from the registry, which is the one thing a lockfile
# exists to prevent, and a later install with scripts enabled would undo
# --ignore-scripts: nothing here needs a postinstall, since the image gets
# ffmpeg from apt and ffmpeg-static's download is dead weight. Dev dependencies
# are asked for by name (`--include=dev`), not left to npm's default, which a
# NODE_ENV=production in this stage would turn off, because tsc needs them; they
# are pruned below rather than shipped.
RUN npm ci --workspace apps/server --include-workspace-root --include=dev --ignore-scripts --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build --workspace apps/server \
 && npm prune --omit=dev --workspace apps/server --include-workspace-root --ignore-scripts --no-audit --no-fund

FROM node:22-slim
# No curl: the health check below is the only thing that wanted it, and node can
# make one request by itself. A container that decodes attacker-supplied video
# should not also ship a ready-made way to send the API key somewhere.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
# HOST: inside a container every interface is the container's own, and the
# published port is the boundary - docker-compose.yml keeps that on loopback.
# KIT_DATA_DIR: where the website's account and shop keep their records (src/account.ts), off
# until APP_URL and the rest are set. A volume of its own in docker-compose.yml, so a purchase
# outlives the container.
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 TMP_DIR=/tmp/tvsham KIT_DATA_DIR=/var/lib/tvsham/account
WORKDIR /app
# Only what the server runs: the compiled output, the shared package it imports,
# the kit it mounts for the website's account and shop (plain JavaScript, run as
# it is from apps/server/kit, beside dist), and the pruned production
# dependencies. typescript, tsx and the rest of the dev tree have no business in
# a container that decodes uploaded video.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/shared ./packages/shared
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/kit ./apps/server/kit
RUN mkdir -p /tmp/tvsham /var/lib/tvsham && chown node:node /tmp/tvsham /var/lib/tvsham
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
