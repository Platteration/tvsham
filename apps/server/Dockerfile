FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm ci --workspace apps/server --include-workspace-root --omit=dev --ignore-scripts || npm install --workspace apps/server --omit=dev --ignore-scripts
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm install --workspace apps/server --include=dev --no-audit --no-fund && npm run build --workspace apps/server

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8787 TMP_DIR=/tmp/tvsham
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /tmp/tvsham && chown node:node /tmp/tvsham
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "apps/server/dist/index.js"]
