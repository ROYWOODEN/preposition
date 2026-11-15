FROM node:26-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /app/data

WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/bot.sqlite \
    BACKUP_DIR=/app/data/backups

USER node
CMD ["node", "dist/main.js", "--migrate"]
