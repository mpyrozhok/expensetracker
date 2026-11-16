# syntax=docker/dockerfile:1.6
#
# Single-image build: the backend serves the compiled SPA from STATIC_DIR, so the
# container exposes one origin for the REST API, the WebSocket upgrade and the
# static bundle. That removes CORS and the reverse proxy from the local setup.
#
#   docker build -f docker/Dockerfile -t expense-tracker .
#   docker run --rm -p 8787:8787 -v expense-data:/data expense-tracker

# ------------------------------------------------------------------ build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for Node LTS; the toolchain is only used
# when this platform has to fall back to a source build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Manifests first, so a source-only change does not re-resolve dependencies.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --cache /tmp/npmcache

# The frontend imports the API types from the backend with type-only imports, so
# both trees have to be present for the build.
COPY tsconfig.json vitest.workspace.ts ./
COPY backend ./backend
COPY frontend ./frontend

RUN npm run build \
 && npm prune --omit=dev

# ---------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/app.db \
    STATIC_DIR=/app/frontend/dist \
    ALLOW_MOCK_AUTH=0
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/frontend/dist ./frontend/dist

# SQLite lives on a volume; WAL needs the directory to be writable by `node`.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/index.js"]
