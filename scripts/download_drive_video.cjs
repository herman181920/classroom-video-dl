#!/usr/bin/env node
// Download a Google Drive video that lives behind your signed-in Google account.
//
// Usage:
//   node download_drive_video.cjs <DRIVE_FILE_ID>           # headless, must already be signed in
//   LOGIN=1 node download_drive_video.cjs <DRIVE_FILE_ID>   # opens headed browser, waits up to 30 min for sign-in
//
// Mechanism:
//   - Persistent Chromium profile holds the signed-in session.
//   - Calls Drive's internal playback API with a SAPISIDHASH derived from the SAPISID cookie.
//   - Streams videoplayback bytes via CDP Fetch.takeResponseBodyAsStream straight to disk.

const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const VIDEO_ID = process.argv[2];
if (!VIDEO_ID) { console.error('usage: download_drive_video.cjs <DRIVE_FILE_ID>'); process.exit(2); }

const TARGET_EMAIL = process.env.USER_EMAIL
  ? new RegExp(process.env.USER_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  : null;
const OUT_DIR = path.resolve(__dirname, '..', 'recordings');
const PROFILE = process.env.COURSE_DL_PROFILE
  || path.join(process.env.HOME, process.platform === 'darwin'
       ? 'Library/Caches/course-dl/profile'
       : '.cache/course-dl/profile');
const API_KEY = 'AIzaSyDVQw45DwoYh632gvsP5vPDqEKvb-Ywnb8';
const LOGIN_MODE = process.env.LOGIN === '1';

function sapihash(v) {
  const t = Math.floor(Date.now() / 1000);
  return `SAPISIDHASH ${t}_${crypto.createHash('sha1').update(`${t} ${v} https://drive.google.com`).digest('hex')}`;
}

async function findTargetAuthuser(page) {
  for (const au of [0,1,2,3,4]) {
    try {
      await page.goto(`https://drive.google.com/u/${au}/`, { waitUntil:'domcontentloaded', timeout:15000 });
      await page.waitForTimeout(800);
      if (page.url().includes('accounts.google.com')) continue;
      if ((await page.title()).includes('404')) continue;
      const aria = await page.evaluate(()=>{const a=document.querySelector('a[aria-label*="Google Account"]');return a&&a.getAttribute('aria-label');}).catch(()=>null);
      if (aria && (!TARGET_EMAIL || TARGET_EMAIL.test(aria))) return au;
    } catch(e) {}
  }
  return -1;
}

async function getStream(page, vid, auth, au) {
  const url = `https://workspacevideo-pa.clients6.google.com/v1/drive/media/${vid}/playback?auditContext=forDisplay&key=${API_KEY}`;
  const d = await page.evaluate(async ({ url, auth, au }) => {
    const r = await fetch(url, { credentials:'include', headers:{ 'Authorization':auth, 'X-Goog-Authuser':String(au) } });
    return { ok:r.ok, status:r.status, body:await r.text() };
  }, { url, auth, au });
  if (!d.ok) throw new Error(`playback API ${d.status}: ${d.body.slice(0,200)}`);
  const j = JSON.parse(d.body);
  const f = JSON.parse(j.mediaStreamingData.serializedHouseBrandPlayerResponse);
  const formats = f.streamingData.formats || [];
  const fmt = formats.find(x=>x.itag===22) || formats[formats.length-1];
  return { url:fmt.url, quality:fmt.qualityLabel, title:f.videoDetails && f.videoDetails.title };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive:true });
  fs.mkdirSync(PROFILE, { recursive:true });

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel:'chrome', headless:!LOGIN_MODE,
    args:['--disable-blink-features=AutomationControlled','--no-first-run'],
    viewport:{ width:1280, height:800 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  let au = await findTargetAuthuser(page);
  if (au < 0) {
    if (!LOGIN_MODE) {
      console.error('Target account not signed in. Re-run with LOGIN=1 to authenticate.');
      await ctx.close(); process.exit(3);
    }
    console.log('Sign in to your Google account in the browser window. Waiting up to 30 min...');
    await page.goto('https://accounts.google.com/AddSession?continue=https://drive.google.com/', { waitUntil:'domcontentloaded' }).catch(()=>{});
    await page.bringToFront().catch(()=>{});
    // Passive wait: poll cookies (no page navigation) until SAPISID appears, indicating sign-in.
    // Only then open a probe tab to verify the signed-in account matches USER_EMAIL (if set).
    const dl = Date.now() + 30*60*1000;
    while (Date.now() < dl) {
      await new Promise(r=>setTimeout(r,3000));
      const cs = await ctx.cookies('https://drive.google.com').catch(()=>[]);
      if (!cs.some(c => c.name === 'SAPISID')) continue;
      const probe = await ctx.newPage();
      try { au = await findTargetAuthuser(probe); } catch(e) {}
      await probe.close().catch(()=>{});
      if (au >= 0) break;
      // Signed in but not as the target account yet — keep waiting (user may add it as a second account).
    }
    if (au < 0) { console.error('Sign-in timeout.'); await ctx.close(); process.exit(4); }
  }
  console.log(`signed in at authuser=${au}`);

  const cookies = await ctx.cookies('https://drive.google.com');
  const sapisid = cookies.find(c=>c.name==='SAPISID');
  if (!sapisid) { console.error('SAPISID cookie missing'); await ctx.close(); process.exit(5); }
  const auth = sapihash(sapisid.value);

  const stream = await getStream(page, VIDEO_ID, auth, au).catch(e => { console.error(e.message); return null; });
  if (!stream) { await ctx.close(); process.exit(6); }
  console.log(`title="${stream.title}" quality=${stream.quality}`);

  const safe = (stream.title || `drive_${VIDEO_ID}`).replace(/[\/\\:*?"<>|]/g,'_').slice(0,120);
  const out = path.join(OUT_DIR, safe.endsWith('.mp4') ? safe : safe + '.mp4');

  // Dedup: skip if a file containing this Drive ID already exists at >1 MB
  // (handles both the title-naming and drive_<id>-naming conventions).
  const existing = fs.readdirSync(OUT_DIR).find(f =>
    f.endsWith('.mp4') && f.includes(VIDEO_ID) &&
    fs.statSync(path.join(OUT_DIR, f)).size > 1024 * 1024
  );
  if (existing) {
    console.log(`Already exists: ${existing} (${(fs.statSync(path.join(OUT_DIR, existing)).size/1048576).toFixed(1)} MB)`);
    await ctx.close(); return;
  }

  const client = await ctx.newCDPSession(page);
  await client.send('Fetch.enable', { patterns:[{ urlPattern:'*videoplayback*', requestStage:'Response' }] });
  const ws = fs.createWriteStream(out);
  let total = 0;
  const t0 = Date.now();
  let streaming = false;  // ensure we only consume the body once
  const done = new Promise((resolve, reject) => {
    client.on('Fetch.requestPaused', async (p) => {
      const s = p.responseStatusCode;
      // 3xx redirects: let the browser follow; the redirected videoplayback
      // request will trigger this handler again with 200/206.
      if (s >= 300 && s < 400) {
        await client.send('Fetch.continueResponse', { requestId:p.requestId }).catch(()=>{});
        return;
      }
      if (s !== 200 && s !== 206) {
        await client.send('Fetch.continueResponse', { requestId:p.requestId }).catch(()=>{});
        return reject(new Error(`HTTP ${s}`));
      }
      if (streaming) {
        // We already grabbed one 200/206 stream; let any duplicate range
        // requests pass through to the browser without intercepting.
        await client.send('Fetch.continueResponse', { requestId:p.requestId }).catch(()=>{});
        return;
      }
      streaming = true;
      try {
        const { stream:h } = await client.send('Fetch.takeResponseBodyAsStream', { requestId:p.requestId });
        let eof = false;
        while (!eof) {
          const c = await client.send('IO.read', { handle:h, size:1024*1024 });
          if (c.data) {
            const buf = c.base64Encoded ? Buffer.from(c.data,'base64') : Buffer.from(c.data);
            ws.write(buf); total += buf.length;
            process.stdout.write(`\r  ${(total/1048576).toFixed(1)} MB`);
          }
          eof = c.eof;
        }
        await client.send('IO.close', { handle:h });
        ws.end();
        console.log(`\nDone: ${(total/1048576).toFixed(1)} MB in ${((Date.now()-t0)/1000).toFixed(0)}s -> ${out}`);
        resolve(total);
      } catch(e) { ws.end(); reject(e); }
    });
  });
  page.evaluate(async u => { await fetch(u, { credentials:'include' }); }, stream.url).catch(()=>{});
  try {
    await Promise.race([done, new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 60min')), 60*60*1000))]);
  } catch (e) {
    console.error('\n' + e.message);
    if (fs.existsSync(out) && fs.statSync(out).size < 1024*1024) fs.unlinkSync(out);
    await ctx.close(); process.exit(7);
  }
  await ctx.close();
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
