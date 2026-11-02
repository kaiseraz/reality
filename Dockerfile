# Reality server + built web app in one image. Sandboxes are separate containers that
# the server starts through the host's Docker engine (see deploy/README.md).

FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/schemas/package.json packages/schemas/
COPY packages/workspace/package.json packages/workspace/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build --workspace @reality/web

FROM node:24.20.0-bookworm-slim
# Only the Docker CLI (a static binary); the engine is the host's, via the mounted socket.
COPY --from=docker:29.8.2-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8787 \
    AUTH=on \
    WEB_DIST=/app/apps/web/dist \
    SAMPLES_DIR=/app/samples
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/tsconfig.base.json ./
COPY --from=build /app/packages packages
COPY --from=build /app/apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
COPY samples samples
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
