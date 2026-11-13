FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY apps/api/src apps/api/src
COPY packages/shared packages/shared
RUN npm run build:shared
RUN npm run build --workspace @affiliateos/api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev
RUN apk add --no-cache ffmpeg font-dejavu \
  && ffmpeg -hide_banner -filters 2>/dev/null | grep -q drawtext \
  && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264 \
  && test -f /usr/share/fonts/dejavu/DejaVuSans.ttf
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY apps/api/drizzle apps/api/drizzle
COPY apps/api/scripts/run-migrations.mjs apps/api/scripts/run-migrations.mjs
COPY apps/api/scripts/verify-migrations.mjs apps/api/scripts/verify-migrations.mjs
COPY apps/api/scripts/verify-migrations-preflight.mjs apps/api/scripts/verify-migrations-preflight.mjs
COPY apps/api/scripts/migration-ledger-preflight.mjs apps/api/scripts/migration-ledger-preflight.mjs
COPY apps/api/scripts/supabase-migration-ledger-audit.mjs apps/api/scripts/supabase-migration-ledger-audit.mjs
RUN mkdir -p /var/lib/affiliateos/secrets && chown -R node:node /var/lib/affiliateos
WORKDIR /app/apps/api
VOLUME ["/var/lib/affiliateos/secrets"]
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
