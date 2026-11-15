FROM node:26-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ util-linux \
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

# BotHost mounts /app/data at runtime, replacing the directory from the image.
USER root
CMD ["sh", "-ec", "if ! runuser -u node -- test -w /app/data || ! runuser -u node -- test -x /app/data; then install -d -o node -g node -m 0700 /app/data; fi; exec runuser -u node -- node dist/main.js --migrate"]
