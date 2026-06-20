# IPTV proxy + ffmpeg (HEVC remux/transcode).
# Render: set the service Runtime/Environment to "Docker" so this image is used.
FROM node:20-bookworm-slim

# ffmpeg provides the /stream remux + transcode pipeline.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
