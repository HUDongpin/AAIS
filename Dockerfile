# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder
WORKDIR /app
ARG AAIS_GIT_SHA=unknown
ARG AAIS_REQUIRE_STABLE_SERVER_ACTIONS_KEY=false
ENV AAIS_DEPLOYMENT_GIT_COMMIT_SHA=${AAIS_GIT_SHA}
COPY . .
RUN mkdir -p public .aais-runtime-cache
RUN --mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
  if [ -s /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY ]; then \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(tr -d '\r\n' < /run/secrets/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)"; \
    export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY; \
  elif [ "$AAIS_REQUIRE_STABLE_SERVER_ACTIONS_KEY" = "true" ]; then \
    echo "AAIS production build requires the Server Actions encryption key secret." >&2; \
    exit 1; \
  fi; \
  npm run build

FROM gcr.io/distroless/nodejs24-debian13@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79 AS runtime
ARG AAIS_GIT_SHA=unknown
ARG AAIS_BUILD_TIMESTAMP=unknown
LABEL org.opencontainers.image.title="AAIS" \
      org.opencontainers.image.revision="${AAIS_GIT_SHA}" \
      org.opencontainers.image.created="${AAIS_BUILD_TIMESTAMP}"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /app
COPY --from=builder --chown=10001:10001 /app/public ./public
COPY --from=builder --chown=10001:10001 /app/.next/standalone ./
COPY --from=builder --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=builder --chown=10001:10001 /app/.aais-runtime-cache ./.next/cache

USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/api/system/live',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["server.js"]
