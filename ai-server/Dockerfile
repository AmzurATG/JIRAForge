# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Builder: has source, compiles portal, bundles the Node server, then is discarded
# ---------------------------------------------------------------------------
FROM node:20.18-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/bundle-server.js ./scripts/bundle-server.js
RUN npm ci \
  && npm install --no-save esbuild@0.25.9

COPY src ./src

WORKDIR /app/src/portal
RUN npm ci \
  && npm run build -- --sourcemap false

WORKDIR /app
RUN node scripts/bundle-server.js \
  && mkdir -p assets/dashboard assets/legal assets/feedback assets/portal \
  && cp src/dashboard/admin-dashboard.html assets/dashboard/ \
  && cp -a src/legal/. assets/legal/ \
  && cp src/feedback/feedback-form.html src/feedback/feedback-form.js assets/feedback/ \
  && cp -a src/portal/build assets/portal/build \
  && npm prune --omit=dev \
  && rm -rf src scripts

# ---------------------------------------------------------------------------
# Runtime: production node_modules + bundled server + static assets only
# ---------------------------------------------------------------------------
FROM node:20.18-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    ASSET_ROOT=/app/assets \
    START_SERVER=true \
    LOG_TO_CONSOLE=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/logs \
  && chown -R node:node /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/assets ./assets

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
