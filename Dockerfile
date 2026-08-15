# syntax=docker/dockerfile:1
# Two-stage build for the grok-remote relay (relay + web client, one service).
#
# web/vendor/ is COMMITTED (since 2026-07-19), so the image builds from a bare
# clone. `npm run build` runs check:vendor first — the build stage therefore
# needs the check's inputs (its two scripts + web/vendor/ with its manifest),
# and a vendor commit that doesn't match its manifest fails the deploy here
# instead of shipping. The sibling-extension comparison self-skips in-image.

# ---------- stage 1: build (vendor check + tsc -> dist/) ----------
FROM node:20-alpine AS build
WORKDIR /app
# Deps first for layer caching; npm ci needs package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/check-ui-vendor.mjs scripts/ui-vendor-manifest.mjs ./scripts/
COPY web/vendor/ ./web/vendor/
COPY src/ ./src/
RUN npm run build

# ---------- stage 2: runtime (slim, prod deps only) ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# Bind all interfaces inside the container (the app default 127.0.0.1 would be
# unreachable from outside the container).
ENV RELAY_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Compiled server + the web client. web/ MUST already include web/vendor/
# (populated by `npm run sync-ui` before the build — it is gitignored).
COPY --from=build /app/dist/ ./dist/
COPY web/ ./web/
EXPOSE 8787
# No curl in alpine — probe /api/health with Node's global fetch. The endpoint
# probes no dependencies, so a db/Clerk blip won't trigger a restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
