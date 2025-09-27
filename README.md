# iptv-proxy-web

Single Node/Express app that serves:
- Static frontend (HLS player) at `/`
- Proxy endpoint at `/proxy?ua=vlc&url=...` which:
  - Rewrites `.m3u8` to route segment requests back through `/proxy`
  - Streams `.ts` and other media pass-through
  - Sets permissive CORS for browser playback

> **Legal**: Use only with content you have the right to access/retransmit. Hosts may suspend services upon abuse/DMCA complaints.

## Local run
```bash
npm install
npm start
# open http://localhost:8080
```

## Deploy — Render (simplest)
1. Push this folder to a GitHub repo.
2. On https://render.com → New → Web Service → Connect repo.
3. Settings:
   - Environment: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free** (for tests)
   - Region: EU (Frankfurt) if you want lower latency from PT.
4. Open the generated URL. The player uses `/proxy` automatically.

## Deploy — Koyeb
1. Push to GitHub.
2. On https://app.koyeb.com → Create App → from GitHub.
3. Buildpack: **Node.js**
4. Environment variables: (optional) `NODE_ENV=production`
5. Exposed port: **PORT** (the app listens on `$PORT` or 8080).
6. Region: choose EU.
