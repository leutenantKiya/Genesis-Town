# Genesis Town: one Node 24 process serves the client (static files) and the API, and runs the game loop.
# The SQLite database lives on a persistent volume at /data. Secrets come from the host's environment variables,
# never from this image (see docs/deploy.md).
FROM node:24.22.1-bookworm-slim

WORKDIR /app

# dependencies first, so code changes don't reinstall them
COPY server/package.json server/package-lock.json server/
RUN npm --prefix server ci --omit=dev
COPY client/build/package.json client/build/package-lock.json client/build/
RUN npm --prefix client/build ci

COPY . .
# bundle the NEAR browser libraries into client/vendor/near.js, then drop the bundler
RUN npm run build:client && rm -rf client/build/node_modules \
  && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/genesis-town.db \
    TRUST_PROXY=1
VOLUME ["/data"]
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/src/main.ts"]
