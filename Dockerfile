# syntax=docker/dockerfile:1
# =============================================================================
# IOT // DASHBOARD — production image
#
#   docker build -t iot-monitoring-dashboard .
#   docker compose up -d --build
#
# NOTE ON THE BASE IMAGE
#   The original brief specified node:18-alpine. better-sqlite3 (^13) declares
#   "engines": { "node": ">=22" }, so the default here is the Node 22 LTS image
#   (Node 18 is also end-of-life). To force another major version:
#
#     docker build --build-arg NODE_VERSION=18 .
#
#   ...but only after pinning better-sqlite3 to a release that supports it
#   (^11 for Node 18). See HANDOVER.md → "Node version".
# =============================================================================

ARG NODE_VERSION=22

# -----------------------------------------------------------------------------
# Stage 1 — dependencies (native modules are compiled/bundled here)
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps

WORKDIR /app

# Toolchain for better-sqlite3 in case no prebuilt binary matches the platform.
RUN apk add --no-cache --virtual .build-deps python3 make g++

COPY package.json package-lock.json ./
COPY scripts/vendor.js ./scripts/vendor.js

# --ignore-scripts: better-sqlite3 ships prebuilds in the package itself, and
# this keeps the install reproducible. The require() below proves the binding
# actually loads; if not, we compile it from source.
RUN npm ci --omit=dev --ignore-scripts \
 && (node -e "require('better-sqlite3')" \
     || npm rebuild better-sqlite3 --build-from-source) \
 && node scripts/vendor.js \
 && npm cache clean --force \
 && apk del .build-deps

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/iot.db

WORKDIR /app

# tini = correct signal handling for the graceful shutdown path in src/server.js
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# SQLite database lives on a volume; run as the unprivileged "node" user.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
