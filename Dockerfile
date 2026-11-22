# One image for all four services. They differ only in the command compose runs,
# so there is one build and one set of dependencies to keep straight.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# the mock courier is plain js, it ships as it is
COPY mock-courier.js ./

# exec form on purpose: node ends up as PID 1 and gets SIGTERM directly, so the
# shutdown handlers actually run. wrapping this in npm or sh would swallow it.
CMD ["node", "dist/src/server.js"]
