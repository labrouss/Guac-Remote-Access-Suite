# Build context is the repo root (see docker-compose.yml: context: ., dockerfile: backend/Dockerfile)
# so this Dockerfile can reach migrations/ and VERSION which live outside backend/.

FROM node:20-alpine AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install
COPY backend/. .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/node_modules/.bin ./node_modules/.bin
COPY migrations ./migrations
COPY VERSION ./VERSION
COPY locales ./locales

EXPOSE 8080
# npm's own "start" script (package.json: "node dist/src/server.js"), not a
# hardcoded path here — this Dockerfile previously hardcoded
# "dist/server.js" directly, which was wrong: backend's tsconfig.json has
# rootDir "." (not "src"), so tsc preserves the src/ prefix in its output,
# producing dist/src/server.js, not dist/server.js. Confirmed by a real
# docker compose up crash-looping on "Cannot find module
# '/app/dist/server.js'". Delegating to the npm script instead of
# duplicating the path here means this can't drift out of sync with
# tsconfig.json again the same way.
CMD ["npm", "start"]
