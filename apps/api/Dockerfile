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
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
