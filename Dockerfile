# Node 22+ is required — this app uses the built-in node:sqlite module
# (no native compilation needed, which is also why we don't need build-essential here)
FROM node:22-slim

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Fly.io mounts the persistent volume at /app/data — created at runtime,
# but make sure the directory exists so the first boot doesn't fail on it
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "--no-warnings", "server/index.js"]
