// server.js — v3.1
import http from 'http';
import https from 'https';
import express from 'express';
import compression from 'compression';
import { pipeline } from 'stream';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();

app.set('trust proxy', true);
app.get('/health', (_, res) => res.type('text').send('ok'));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(compression({
  filter: (req, res) => {
    const t = String(res.getHeader('Content-Type') || '').toLowerCase();
    return /text|json|javascript|xml|mpegurl/.test(t);
  }
}));

const BASIC_USER = process.env.BASIC_AUTH_USER || 'rui';
const BASIC_PASS = process.env.BASIC_AUTH_PASS || 'Qwerty86!';
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!BASIC_USER || !BASIC_PASS) return next();
  const hdr = String(req.headers.authorization || '');
  if (hdr.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(hdr.slice(6), 'base64').toString('utf8').split(':');
    if (user === BASIC_USER && pass === BASIC_PASS) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
  return res.status(401).send('Auth required');
});

const pubDir = path.join(__dirname, 'public');
app.use(express.static(pubDir, { index: 'index.html', maxAge: '1h' }));
app.get('/', (req, res) => {
  const index = path.join(pubDir, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.status(200).type('text').send('Frontend missing (public/index.html). Proxy at /proxy');
});

const UAS = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  vlc:    'VLC/3.0.20 LibVLC/3.0.20',
  iptv:   'IPTV-Smarters-Player',
};
const pickUA = req => UAS[String(req.query.ua||'').toLowerCase()] || UAS.vlc;

const isM3U8 = (urlObj, headers) => {
  const ct = String(headers['content-type'] || '').toLowerCase();
  return urlObj.pathname.toLowerCase().endsWith('.m3u8') ||
         ct.includes('application/vnd.apple.mpegurl') ||
         ct.includes('application/x-mpegurl');
};

function proxyOnce(targetUrl, req, res, hop = 0) {
  if (hop > 5) return !res.headersSent && res.status(508).send('Too many redirects');

  let target;
  try { target = new URL(targetUrl); }
  catch { return !res.headersSent && res.status(400).send('invalid url'); }

  const isHttps = target.protocol === 'https:', lib = isHttps ? https : http;

  const headers = {
    'User-Agent': pickUA(req),
    'Accept': req.headers['accept'] || '*/*',
    'Accept-Encoding': 'identity',
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
    headers, timeout: 15000,
    agent: new (isHttps ? https.Agent : http.Agent)({ keepAlive: false }),
  };

  const upstreamReq = lib.request(options, (up) => {
    const status = up.statusCode || 0;

    if ([301,302,303,307,308].includes(status)) {
      const loc = up.headers.location; up.resume();
      if (!loc) return !res.headersSent && res.status(502).send('redirect without Location');
      return proxyOnce(new URL(loc, target).toString(), req, res, hop + 1);
    }

    if (String(req.query.inspect) === '1') {
      const chunks = [];
      up.on('data', d => { if (chunks.length < 64) chunks.push(d); });
      up.on('end', () => {
        const preview = Buffer.concat(chunks).toString('utf8').slice(0, 4096);
        res.status(200).json({
          resolvedUrl: target.toString(),
          status, headers: up.headers,
          willRewrite: isM3U8(target, up.headers),
          previewFirst4KB: preview
        });
      });
      up.on('error', () => { if (!res.headersSent) res.status(502).json({ error:'Upstream stream error' }); });
      return;
    }

    const headersToSend = { ...up.headers };
    const willRewrite = isM3U8(target, up.headers);

    if (willRewrite) {
      delete headersToSend['content-encoding'];
      delete headersToSend['transfer-encoding'];
      delete headersToSend['content-length'];
      headersToSend['content-type'] = 'application/vnd.apple.mpegurl';

      const chunks = [];
      up.on('data', d => chunks.push(d));
      up.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');

          const baseQS = new URLSearchParams();
          const ua = String(req.query.ua || '');
          if (ua) baseQS.set('ua', ua);
          if (req.query.referer) baseQS.set('referer', String(req.query.referer));
          if (req.query.origin)  baseQS.set('origin',  String(req.query.origin));
          if (req.query.cap_kbps)     baseQS.set('cap_kbps', String(req.query.cap_kbps));
          if (req.query.force_lowest) baseQS.set('force_lowest', '1');
          if (req.query.avoid_codecs) baseQS.set('avoid_codecs', String(req.query.avoid_codecs));
          if (req.query.prefer_codecs) baseQS.set('prefer_codecs', String(req.query.prefer_codecs));

          const toProxy = (absUrl) => {
            const u = new URL(absUrl);
            const qs = new URLSearchParams(baseQS.toString());
            qs.set('host', u.host);
            qs.set('url', u.toString());
            return `/proxy?${qs.toString()}`;
          };

          let outText = text;

          if (/#EXT-X-STREAM-INF/i.test(text)) {
            const lines = text.split(/\r?\n/);
            const headerLines = [];
            const variants = []; // {info, url, bw, codecs}

            for (let i = 0; i < lines.length; i++) {
              const L = lines[i];
              if (/^#EXT-X-STREAM-INF:/i.test(L)) {
                const urlLine = lines[i+1] && lines[i+1].trim();
                if (urlLine && !urlLine.startsWith('#')) {
                  const abs = new URL(urlLine, target).toString();
                  const bwMatch = /BANDWIDTH=(\d+)/i.exec(L);
                  const bw = bwMatch ? parseInt(bwMatch[1],10) : undefined;
                  const cm = /CODECS="([^"]+)"/i.exec(L);
                  const codecs = cm ? cm[1].toLowerCase() : '';
                  variants.push({ info: L, url: abs, bw, codecs });
                  i++;
                  continue;
                }
              }
              if (!L || L.startsWith('#')) headerLines.push(L);
            }

            const capKbps = parseInt(String(req.query.cap_kbps || ''), 10);
            const forceLowest = String(req.query.force_lowest || '') === '1';
            const avoidList = String(req.query.avoid_codecs || '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
            const preferList = String(req.query.prefer_codecs || '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);

            let pool = variants.slice();

            if (avoidList.length) {
              pool = pool.filter(v => !avoidList.some(a => v.codecs.includes(a)));
            }

            if (preferList.length && pool.length) {
              const preferred = pool.filter(v => preferList.some(p => v.codecs.includes(p)));
              if (preferred.length) pool = preferred;
            }

            if (forceLowest && pool.length) {
              pool = [ pool.reduce((a,b)=> (a.bw||1e12) <= (b.bw||1e12) ? a : b) ];
            } else if (!isNaN(capKbps) && capKbps > 0 && pool.length) {
              const cap = capKbps * 1000;
              const fit = pool.filter(v => (v.bw||Infinity) <= cap);
              pool = fit.length ? fit : [ pool.reduce((a,b)=> (a.bw||1e12) <= (b.bw||1e12) ? a : b) ];
            }

            const body = (pool.length ? pool : variants).map(g => `${g.info}\n${toProxy(g.url)}`).join('\n');
            outText = headerLines.join('\n') + '\n' + body + '\n';
          } else {
            outText = text.split(/\r?\n/).map(line => {
              const t = line.trim();
              if (!t || t.startsWith('#')) return line;
              const abs = new URL(t, target).toString();
              return toProxy(abs);
            }).join('\n');
          }

          if (!res.headersSent) res.writeHead(status || 200, headersToSend);
          res.end(outText);
        } catch (e) {
          if (!res.headersSent) res.status(502).end('rewrite error: ' + e.message);
          else res.end();
        }
      });
      up.on('error', () => { if (!res.headersSent) res.status(502).end('upstream stream error'); else res.end(); });
      return;
    }

    delete headersToSend['content-encoding'];
    if (!res.headersSent) res.writeHead(status || 200, headersToSend);
    pipeline(up, res, (err) => {
      if (err) { try { if (!res.headersSent) res.status(502).end('proxy pipe error'); else res.end(); } catch {} }
    });
  });

  upstreamReq.on('error', (err) => { if (!res.headersSent) res.status(502).send('proxy error: ' + err.message); else try { res.end(); } catch {} });
  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
  req.on('aborted', () => upstreamReq.destroy());
  upstreamReq.end();
}

app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));

app.get('/proxy', (req, res) => {
  const raw = String(req.query.url || '');
  if (!raw) return res.status(400).send('missing url');
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
