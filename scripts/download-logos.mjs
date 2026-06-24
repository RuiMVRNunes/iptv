// Download channel logos into public/logos/<stream_id>.png
//
// Why this exists: the provider's icon host (pycon.oirza.com) returns 403 to
// bare User-Agents and blocks datacenter IPs, so the logos can't be fetched at
// runtime from Render. We pre-download them from a residential IP (with a
// browser User-Agent) and ship them as static assets. The client falls back to
// a coloured initial for any channel without a logo.
//
// Run from the repo root (residential network):  node scripts/download-logos.mjs
// Then commit the new/updated files under public/logos and redeploy.

import http from 'http';
import https from 'https';
import { writeFileSync, mkdirSync, readdirSync } from 'fs';

const XTREAM = process.env.XTREAM_URL || 'http://zxc.rekpv.com:8080';
const USER = process.env.XTREAM_USER || 'uvxctmoh';
const PASS = process.env.XTREAM_PASS || 'pLv486e0Qh';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const OUT = 'public/logos';
const CONCURRENCY = 12;

function fetchImage(url, redirects = 3) {
    return new Promise(resolve => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { headers: { 'User-Agent': UA, 'Referer': XTREAM, 'Accept': 'image/*,*/*' } }, r => {
            if ([301, 302, 307, 308].includes(r.statusCode) && r.headers.location && redirects > 0) {
                r.resume();
                return fetchImage(new URL(r.headers.location, url).toString(), redirects - 1).then(resolve);
            }
            if (r.statusCode !== 200 || !String(r.headers['content-type'] || '').includes('image')) {
                r.resume();
                return resolve(null);
            }
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    });
}

async function main() {
    mkdirSync(OUT, { recursive: true });
    const apiUrl = `${XTREAM}/player_api.php?username=${USER}&password=${PASS}&action=get_live_streams`;
    const list = JSON.parse(await (await fetch(apiUrl)).text());
    const withIcon = list.filter(s => s.stream_icon);
    console.log(`${list.length} canais, ${withIcon.length} com logo`);

    let ok = 0, fail = 0, i = 0;
    async function worker() {
        while (i < withIcon.length) {
            const s = withIcon[i++];
            const buf = await fetchImage(s.stream_icon);
            if (buf && buf.length > 100) { writeFileSync(`${OUT}/${s.stream_id}.png`, buf); ok++; }
            else fail++;
            if ((ok + fail) % 40 === 0) console.log(`...${ok + fail}/${withIcon.length}`);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log(`\nDescarregados: ${ok} ok / ${fail} sem logo`);
    console.log(`Total em ${OUT}: ${readdirSync(OUT).length} ficheiros`);
}

main();
