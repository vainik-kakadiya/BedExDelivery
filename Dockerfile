# syntax=docker/dockerfile:1
# One Dockerfile, three images (pick with --target or docker-compose.yml):
#   api   – Node API (production deps only)
#   web   – Caddy serving the built web app, proxying /api to the API, with automatic HTTPS
#   tools – full workspace for migrations and seeds (pnpm db:migrate, db:seed, db:seed:demo)

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---------- install + build everything ----------
FROM base AS build
# Manifests first so the dependency layer is cached until they change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .

# The web app's VITE_* values are baked in at build time (they are public in the browser anyway).
ARG VITE_GOOGLE_MAPS_BROWSER_KEY=""
ARG VITE_GOOGLE_MAPS_MAP_ID=""
ENV VITE_GOOGLE_MAPS_BROWSER_KEY=$VITE_GOOGLE_MAPS_BROWSER_KEY \
    VITE_GOOGLE_MAPS_MAP_ID=$VITE_GOOGLE_MAPS_MAP_ID \
    VITE_API_URL=""
RUN pnpm --filter @bedex/api build && pnpm --filter @bedex/web build

# A self-contained copy of the API with production dependencies only.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @bedex/api deploy --prod /out/api && cp -r apps/api/dist /out/api/dist

# ---------- migrations / seeds ----------
FROM build AS tools
CMD ["pnpm", "db:migrate"]

# ---------- API ----------
FROM node:20-bookworm-slim AS api
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.js"]

# ---------- web (Caddy) ----------
FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
