// server.js — v3.2.1 (FFmpeg compat mode; wait-ready + better errors)
import http from 'http';
import https from 'https';
import express from 'express';
import compression from 'compression';
import { pipeline } from 'stream';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import ffmpegPathPkg from 'ffmpeg-static';

const ffmpegPath = process.env.FFMPEG_PATH || ffmpegPathPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();

app.set('trust proxy', true);
app.get('/health', (_, res) => res.type('text').send('ok'));

// CORS + noindex
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Gzip só para texto / m3u8
app.use(compression({
  filter: (req, res) => {
    const t = String(res.getHeader('Content-Type') || '').toLowerCase();
    return /text|json|javascript|xml|mpegurl/.test(t);
  }
}));

// Basic Auth
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

// Static frontend
const pubDir = path.join(__dirname, 'public');
app.use(express.static(pubDir, { index: 'index.html', maxAge: '1h' }));
app.get('/', (req, res) => {
  const index = path.join(pubDir, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.status(200).type('text').send('Frontend missing (public/index.html). Proxy at /proxy');
});

// Utils
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

// ---------------- Proxy core (rewrite .m3u8) ----------------
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

    // Redirect?
    if ([301,302,303,307,308].includes(status)) {
      const loc = up.headers.location; up.resume();
      if (!loc) return !res.headersSent && res.status(502).send('redirect without Location');
      return proxyOnce(new URL(loc, target).toString(), req, res, hop + 1);
    }

    // Inspect (debug)
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

          // Params
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
            // Parse master variants
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

            // Filters
            const capKbps = parseInt(String(req.query.cap_kbps || ''), 10);
            const forceLowest = String(req.query.force_lowest || '') === '1';
            const avoidList = String(req.query.avoid_codecs || '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
            const preferList = String(req.query.prefer_codecs || '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);

            let pool = variants.slice();

            if (avoidList.length) { pool = pool.filter(v => !avoidList.some(a => v.codecs.includes(a))); }
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
            // Media playlist
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

    // Conteúdo não-m3u8 → pipe direto
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

// ---------------- FFmpeg compat mode ----------------
const jobs = new Map(); // id -> { proc, dir, last, failed }
const compatRoot = '/tmp/compat';
fs.mkdirSync(compatRoot, { recursive: true });

function idFor(urlStr, mode, vbr, abr){
  const h = crypto.createHash('sha1').update([urlStr, mode||'', vbr||'', abr||''].join('|')).digest('base64url');
  return h.slice(0, 24);
}

function fileReady(p){
  try {
    if (!fs.existsSync(p)) return false;
    const txt = fs.readFileSync(p, 'utf8');
    return txt.includes('#EXTINF'); // at least one segment
  } catch { return false; }
}

function waitUntilReady(indexPath, timeoutMs=10000){
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (fileReady(indexPath) || (Date.now()-t0) > timeoutMs){
        clearInterval(timer);
        resolve(fileReady(indexPath));
      }
    }, 300);
  });
}

function startJob(srcUrl, mode='remux', opts={}){
  const vbr = opts.vbr || '2500k';
  const abr = opts.abr || '128k';
  const id = idFor(srcUrl, mode, vbr, abr);
  const dir = path.join(compatRoot, id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const commonIn = [
    '-loglevel','warning',
    '-rw_timeout','15000000',
    '-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','2'
  ];

  if (opts.ua) { commonIn.push('-user_agent', String(opts.ua)); }
  if (opts.referer || opts.origin){
    let hdr = '';
    if (opts.referer) hdr += `Referer: ${opts.referer}\r\n`;
    if (opts.origin)  hdr += `Origin: ${opts.origin}\r\n`;
    commonIn.push('-headers', hdr);
  }

  const mapOut = ['-map','0:v:0?','-map','0:a:0?'];

  const outArgs = ['-f','hls','-hls_time','4','-hls_list_size','6','-hls_flags','delete_segments+omit_endlist',
                   '-hls_segment_filename', path.join(dir, 'seg-%06d.ts'), path.join(dir, 'index.m3u8')];

  let codecArgs;
  if (mode === 'remux'){
    codecArgs = ['-c:v','copy','-c:a','aac','-ac','2','-b:a', abr];
  } else {
    codecArgs = ['-c:v','libx264','-preset','veryfast','-tune','zerolatency','-profile:v','high','-level','4.1',
                 '-b:v', vbr, '-maxrate', vbr, '-bufsize', '2M', '-c:a','aac','-ac','2','-b:a', abr];
  }

  const args = [...commonIn, '-i', srcUrl, ...mapOut, ...codecArgs, ...outArgs];

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore','pipe','pipe'] });
  const job = { id, dir, proc, last: Date.now(), mode, vbr, abr, srcUrl, failed:false };

  proc.on('error', (err) => { job.failed = true; });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  proc.on('exit', (code) => {
    if (code && code !== 0) job.failed = true;
  });

  jobs.set(id, job);
  return job;
}

function touchJob(id){ const j = jobs.get(id); if (j) j.last = Date.now(); }

// Serve compat files and update last-access
app.use('/compat', (req, res, next) => {
  const m = req.path.match(/^\/([^/]+)/);
  if (m) touchJob(m[1]);
  next();
}, express.static(compatRoot, { maxAge: 0 }));

// Endpoint to start (or reuse) a job, returns the play URL
app.get('/start-compat', async (req, res) => {
  if (!ffmpegPath) return res.status(500).json({ error:'ffmpeg binary not found' });

  const raw = String(req.query.url || '');
  if (!raw) return res.status(400).json({ error:'missing url' });
  const mode = (String(req.query.mode || 'remux').toLowerCase() === 'transcode') ? 'transcode' : 'remux';
  const vbr = String(req.query.vbr || '2500k');
  const abr = String(req.query.abr || '128k');
  const wait = String(req.query.wait || '1') === '1';
  const autoFallback = String(req.query.auto_fallback || '1') === '1';
  const ua = pickUA(req);
  const referer = String(req.query.referer || '');
  const origin = String(req.query.origin || '');

  const id = idFor(raw, mode, vbr, abr);
  let job = jobs.get(id);
  if (!job || job.proc.exitCode !== null){
    job = startJob(raw, mode, { vbr, abr, ua, referer, origin });
  } else {
    touchJob(id);
  }

  const play = `/compat/${job.id}/index.m3u8`;
  const indexPath = path.join(compatRoot, job.id, 'index.m3u8');

  if (wait){
    const waitMs = (mode === 'transcode') ? 20000 : 12000;  // Mais tempo para transcode
    const ok = await waitUntilReady(indexPath, waitMs);
    if (!ok){
      if (autoFallback && mode === 'remux'){
        // try transcode
        const trans = startJob(raw, 'transcode', { vbr: '4000k', abr, ua, referer, origin });
        const tPlay = `/compat/${trans.id}/index.m3u8`;
        const tIndex = path.join(compatRoot, trans.id, 'index.m3u8');
        const tOk = await waitUntilReady(tIndex, 20000);
        if (!tOk) return res.status(502).json({ error:'compat not ready', detail:'transcode failed to start in time' });
        return res.json({ id: trans.id, mode: 'transcode', play: tPlay });
      }
      return res.status(502).json({ error:'compat not ready' });
    }
  }

  if (job.failed) return res.status(500).json({ error:'ffmpeg failed to start' });
  return res.json({ id: job.id, mode: job.mode, play });
});

// Cleanup loop
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs){
    const idleMs = now - (job.last || 0);
    if (idleMs > 10*60*1000){ // 10 min
      try { job.proc.kill('SIGTERM'); } catch {}
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
      jobs.delete(id);
    }
  }
}, 60*1000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server listening on http://0.0.0.0:' + PORT));
