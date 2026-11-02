# syntax=docker/dockerfile:1
#
# ResQ AI frontend (Next.js 15, `output: "standalone"`) - production image.
#
#   docker build -t resq-ai-frontend ./frontend
#   docker run --rm -p 3000:3000 \
#     -e BACKEND_URL=http://backend:8000 -e NEXTAUTH_URL=http://localhost:3000 \
#     -e NEXTAUTH_SECRET=... -e BACKEND_JWT_SECRET=... -e INTERNAL_API_KEY=... \
#     resq-ai-frontend
#
# Stages: deps (npm ci) -> builder (next build) -> runner (standalone server as `node`).
# Server-side settings (BACKEND_URL, secrets, OAuth credentials) are read at RUNTIME, so one
# image works in every environment. Only NEXT_PUBLIC_* values are inlined at build time.

ARG NODE_VERSION=22

# --------------------------------------------------------------------------------------------
# base: shared settings for every stage
# --------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# --------------------------------------------------------------------------------------------
# deps: install exactly what package-lock.json pins (dev deps are needed for the build)
# --------------------------------------------------------------------------------------------
FROM base AS deps
# Some prebuilt native binaries still expect glibc symbols on musl.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# --------------------------------------------------------------------------------------------
# builder: compile the standalone server bundle
# --------------------------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Public (browser-visible) build-time settings: fallback map centre. Empty = New Delhi.
ARG NEXT_PUBLIC_DEFAULT_LAT=""
ARG NEXT_PUBLIC_DEFAULT_LON=""
# Base URL used for absolute metadata links in pre-rendered pages (runtime value still wins
# for authentication).
ARG NEXTAUTH_URL=http://localhost:3000
ENV NEXT_PUBLIC_DEFAULT_LAT=${NEXT_PUBLIC_DEFAULT_LAT} \
    NEXT_PUBLIC_DEFAULT_LON=${NEXT_PUBLIC_DEFAULT_LON}

# The secrets below are throw-away placeholders that only satisfy `next build`; they are set
# for this single command (not as ENV/ARG), so they never end up in an image layer's config.
# The real values are provided to the runner at runtime.
RUN NEXTAUTH_URL="${NEXTAUTH_URL}" \
    NEXTAUTH_SECRET=docker-build-placeholder \
    BACKEND_JWT_SECRET=docker-build-placeholder \
    npm run build

# --------------------------------------------------------------------------------------------
# runner: only the standalone output, running as the unprivileged `node` user
# --------------------------------------------------------------------------------------------
FROM base AS runner

LABEL org.opencontainers.image.title="resq-ai-frontend" \
      org.opencontainers.image.description="ResQ AI web app and PWA (Next.js)" \
      org.opencontainers.image.source="https://github.com/Mayank-thakur21/resq-ai" \
      org.opencontainers.image.licenses="MIT"

# HOSTNAME must be 0.0.0.0: Docker sets HOSTNAME to the container id and the standalone
# server would otherwise listen on the container IP only (breaking the local healthcheck).
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# .next must be writable by `node` for the image-optimisation / prerender cache.
RUN mkdir .next && chown node:node .next

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server.js"]
