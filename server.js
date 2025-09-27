// server.js — IPTV proxy + frontend (Express, ESM)
// Usa só com conteúdos a que tens direito.

import http from 'http';
import https from 'https';
import express from 'express';
import { pipeline } from 'stream';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Healthcheck
app.get('/health', (_, res) => res.type('text').send('ok'));

// CORS básico para o browser
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Frontend estático
const pubDir = path.join(__dirname, 'public');
app.use(express.static(pubDir, { index: 'index.html', maxAge: '1h' }));
app.get('/', (req, res) => {
  const index = path.join(pubDir, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.status(200).type('text').send('Frontend missing (public/index.html). Proxy at /proxy');
});

// UAs úteis
const UAS = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  vlc:    'VLC/3.0.20 LibVLC/3.0.20',
  iptv:   'IPTV-Smarters-Player',
};
function pickUA(req) {
  const param = String(req.query.ua || '').toLowerCase();
  return UAS[param] || UAS.vlc; // por defeito, VLC
}

function isM3U8PathOrCT(urlObj, headers) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  return urlObj.pathname.toLowerCase().endsWith('.m3u8') ||
         ct.includes('application/vnd.apple.mpegurl') ||
         ct.includes('application/x-mpegurl');
}

// Proxy com follow-redirects (até 5)
function proxyOnce(targetUrl, req, res, hop = 0) {
  if (hop > 5) return !res.headersSent && res.status(508).send('Too many redirects');

  let target;
  try { target = new URL(targetUrl); }
  catch { return !res.headersSent && res.status(400).send('invalid url'); }

  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;

  // Cabeçalhos para upstream
  const headers = {
    'User-Agent': pickUA(req),
    'Accept': req.headers['accept'] || '*/*',
    'Accept-Encoding': 'identity', // evita gzip (facilita reescrita de m3u8)
    'Connection': 'close',
    'Host': (req.query.host || target.host),
  };
  if (req.headers['range']) headers['Range'] = req.headers['range'];
  if (req.headers['icy-metadata']) headers['Icy-MetaData'] = req.headers['icy-metadata'];
  if (req.query.referer) headers['Referer'] = String(req.query.referer);
  if (req.query.origin)  headers['Origin']  = String(req.query.origin);

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

    // Redirect?
    if ([301,302,303,307,308].includes(status)) {
      const loc = upstreamRes.headers.location;
      upstreamRes.resume();
      if (!loc) return !res.headersSent && res.status(502).send('redirect without Location');
      const nextUrl = new URL(loc, target).toString();
      return proxyOnce(nextUrl, req, res, hop + 1);
    }

    // Inspeção: ver o que o origin devolve (para debug)
    if (String(req.query.inspect) === '1') {
      const chunks = [];
      upstreamRes.on('data', d => { if (chunks.length < 64) chunks.push(d); });
      upstreamRes.on('end', () => {
        const preview = Buffer.concat(chunks).toString('utf8').slice(0, 4096);
        res.status(200).json({
          resolvedUrl: target.toString(),
          status,
          headers: upstreamRes.headers,
          willRewrite: isM3U8PathOrCT(target, upstreamRes.headers),
          previewFirst4KB: preview
        });
      });
      upstreamRes.on('error', () => {
        if (!res.headersSent) res.status(502).json({ error: 'Upstream stream error' });
      });
      return;
    }

    const headersToSend = { ...upstreamRes.headers };
    const willRewrite = isM3U8PathOrCT(target, upstreamRes.headers);

    if (willRewrite) {
      // vamos reescrever → não enviamos estes headers como vieram
      delete headersToSend['content-encoding'];
      delete headersToSend['transfer-encoding'];
      delete headersToSend['content-length'];
      headersToSend['content-type'] = 'application/vnd.apple.mpegurl';

      const chunks = [];
      upstreamRes.on('data', d => chunks.push(d));
      upstreamRes.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');

          // Propagar parâmetros úteis (exceto url/inspect)
          const baseQS = new URLSearchParams();
          const ua = String(req.query.ua || '');
          if (ua) baseQS.set('ua', ua);
          if (req.query.referer) baseQS.set('referer', String(req.query.referer));
          if (req.query.origin)  baseQS.set('origin',  String(req.query.origin));

          const proxied = text.split(/\r?\n/).map(line => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return line;
            // relativo → absoluto
            const abs = new URL(t, target).toString();
            const qs = new URLSearchParams(baseQS.toString());
            // para alguns origins, o Host tem de ser igual ao do segmento
            qs.set('host', new URL(abs).host);
            qs.set('url', abs);
            return `/proxy?${qs.toString()}`;
          }).join('\n');

          if (!res.headersSent) res.writeHead(status || 200, headersToSend);
          res.end(proxied);
        } catch (e) {
          if (!res.headersSent) res.status(502).end('rewrite error: ' + e.message);
          else res.end();
        }
      });
      upstreamRes.on('error', () => {
        if (!res.headersSent) res.status(502).end('upstream stream error');
        else res.end();
      });
      return;
    }

    // Conteúdo não m3u8 → pass-through
    delete headersToSend['content-encoding'];
    if (!res.headersSent) res.writeHead(status || 200, headersToSend);
    pipeline(upstreamRes, res, (err) => {
      if (err) {
        try { if (!res.headersSent) res.status(502).end('proxy pipe error'); else res.end(); } catch {}
      }
    });
  });

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).send('proxy error: ' + err.message);
    else try { res.end(); } catch {}
  });

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
  req.on('aborted', () => upstreamReq.destroy());
  upstreamReq.end();
}

app.get('/proxy', (req, res) => {
  // (opcional) proteção por chave: defina PROXY_KEY no Render e passe ?key=...
  const REQUIRED = process.env.PROXY_KEY;
  if (REQUIRED && req.query.key !== REQUIRED) return res.status(403).send('forbidden');

  const raw = String(req.query.url || '');
  if (!raw) return res.status(400).send('missing url');

  // Anti-loop: impedir /proxy → /proxy
  try {
    const host = (req.headers.host || '').split(',')[0].trim();
    const t = new URL(raw);
    if (t.hostname === host && t.pathname.startsWith('/proxy')) {
      return res.status(400).send('recursive proxy blocked');
    }
  } catch {}

  proxyOnce(raw, req, res, 0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server listening on http://0.0.0.0:' + PORT));
