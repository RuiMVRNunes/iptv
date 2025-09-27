// server.js — single-service frontend + proxy (Express)
// - Serves / (static frontend in ./public)
// - /proxy?ua=vlc&url=... rewrites .m3u8 and streams segments pass-through
// NOTE: Use only for legal streams. Respect all copyright/ToS.
import http from 'http';
import https from 'https';
import express from 'express';
import { pipeline } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Static frontend
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options','nosniff');
  }
}));

// CORS for the browser player
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// User Agents that sometimes help upstreams
const UAS = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  vlc:    'VLC/3.0.20 LibVLC/3.0.20',
  iptv:   'IPTV-Smarters-Player',
};
function pickUA(req) {
  const param = String(req.query.ua || '').toLowerCase();
  return UAS[param] || UAS.vlc; // default VLC
}

function isM3U8PathOrCT(urlObj, headers) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  return urlObj.pathname.toLowerCase().endsWith('.m3u8') ||
         ct.includes('application/vnd.apple.mpegurl') ||
         ct.includes('application/x-mpegurl');
}

// Follow redirects up to 5 hops
function proxyOnce(targetUrl, req, res, hop = 0) {
  if (hop > 5) return !res.headersSent && res.status(508).send('Too many redirects');

  let target;
  try { target = new URL(targetUrl); }
  catch { return !res.headersSent && res.status(400).send('invalid url'); }

  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = {
    'User-Agent': pickUA(req),
    'Accept': req.headers['accept'] || '*/*',
    'Accept-Encoding': 'identity', // avoid gzip/deflate
    'Connection': 'close',
    'Host': target.host,
  };
  if (req.headers['range']) headers['Range'] = req.headers['range'];
  if (req.headers['icy-metadata']) headers['Icy-MetaData'] = req.headers['icy-metadata'];

  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    method: 'GET',
    headers,
    timeout: 15000,
    agent: new (isHttps ? https.Agent : http.Agent)({ keepAlive: false }),
  };

  const upstreamReq = lib.request(options, (upstreamRes) => {
    const status = upstreamRes.statusCode || 0;

    if ([301,302,303,307,308].includes(status)) {
      const loc = upstreamRes.headers.location;
      upstreamRes.resume();
      if (!loc) return !res.headersSent && res.status(502).send('Redirect without Location');
      const nextUrl = new URL(loc, target).toString();
      return proxyOnce(nextUrl, req, res, hop + 1);
    }

    const headersToSend = { ...upstreamRes.headers };
    const willRewrite = isM3U8PathOrCT(target, upstreamRes.headers);

    if (willRewrite) {
      delete headersToSend['content-encoding'];
      delete headersToSend['transfer-encoding'];
      delete headersToSend['content-length'];
      headersToSend['content-type'] = 'application/vnd.apple.mpegurl';

      const chunks = [];
      upstreamRes.on('data', d => chunks.push(d));
      upstreamRes.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const ua = String(req.query.ua || '');
          const uaPart = ua ? `ua=${encodeURIComponent(ua)}&` : '';
          const proxied = text.split(/\r?\n/).map(line => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return line;
            const abs = new URL(t, target).toString();
            return `/proxy?${uaPart}url=${encodeURIComponent(abs)}`;
          }).join('\\n');

          if (!res.headersSent) res.writeHead(status || 200, headersToSend);
          res.end(proxied);
        } catch (e) {
          if (!res.headersSent) res.status(502).end('Rewrite error: ' + e.message);
          else res.end();
        }
      });
      upstreamRes.on('error', () => {
        if (!res.headersSent) res.status(502).end('Upstream stream error');
        else res.end();
      });
      return;
    }

    // Non-m3u8 content → pass-through
    delete headersToSend['content-encoding'];
    if (!res.headersSent) res.writeHead(status || 200, headersToSend);
    pipeline(upstreamRes, res, (err) => {
      if (err) {
        try { if (!res.headersSent) res.status(502).end('Proxy pipe error'); else res.end(); } catch {}
      }
    });
  });

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message);
    else try { res.end(); } catch {}
  });

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
  req.on('aborted', () => upstreamReq.destroy());
  upstreamReq.end();
}

app.get('/proxy', (req, res) => {
  const raw = String(req.query.url || '');
  if (!raw) return res.status(400).send('missing url');
  proxyOnce(raw, req, res, 0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server listening on http://0.0.0.0:' + PORT));
