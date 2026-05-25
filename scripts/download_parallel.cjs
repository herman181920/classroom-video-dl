#!/usr/bin/env node
// Parallel Google Drive video downloader.
// One Chromium context, N worker tabs, all sharing one signed-in session.
// Each tab pulls the next pending Drive ID from a shared queue and streams it
// to disk via CDP Fetch interception.
//
// Usage:
//   node download_parallel.cjs                          # default: 3 workers, full plan
//   N=4 node download_parallel.cjs                      # 4 concurrent workers
//   node download_parallel.cjs path/to/plan.json        # custom plan
//
// Requires an already-authenticated profile (run auth_profile.cjs once if not).
// Same profile path as the single-file downloader.

const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PLAN_PATH = process.argv[2] || path.resolve(__dirname, '..', 'videos_plan.json');
const N_WORKERS = parseInt(process.env.N || '3', 10);

const TARGET_EMAIL = process.env.USER_EMAIL
  ? new RegExp(process.env.USER_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  : null;
const OUT_DIR = path.resolve(__dirname, '..', 'recordings');
const PROFILE = process.env.COURSE_DL_PROFILE
  || path.join(process.env.HOME, process.platform === 'darwin'
       ? 'Library/Caches/course-dl/profile'
       : '.cache/course-dl/profile');
const LOG_PATH = path.join(OUT_DIR, '.download_log.jsonl');
const API_KEY = 'AIzaSyDVQw45DwoYh632gvsP5vPDqEKvb-Ywnb8';

function sapihash(v) {
  const t = Math.floor(Date.now() / 1000);
  return `SAPISIDHASH ${t}_${crypto.createHash('sha1').update(`${t} ${v} https://drive.google.com`).digest('hex')}`;
}

async function findTargetAuthuser(page) {
  for (const au of [0,1,2,3,4]) {
    try {
      await page.goto(`https://drive.google.com/u/${au}/`, { waitUntil:'domcontentloaded', timeout:15000 });
      if (page.url().includes('accounts.google.com')) continue;
      if ((await page.title()).includes('404')) continue;
      // Wait up to 10s for the Google Account button to render (headless Chrome can be slow).
      // The previous 500ms-flat wait was racy — sometimes the button hadn't rendered yet
      // and we'd falsely conclude the account wasn't signed in.
      const link = await page.waitForSelector('a[aria-label*="Google Account"]', { timeout:10000 }).catch(()=>null);
      if (!link) continue;
      const aria = await link.getAttribute('aria-label').catch(()=>null);
      if (aria && (!TARGET_EMAIL || TARGET_EMAIL.test(aria))) return au;
    } catch(e) {}
  }
  return -1;
}

async function getStream(page, vid, sapisidValue, au) {
  // Recompute SAPISIDHASH per call — the timestamp inside it must be near-current
  // (Google validates within a few minutes). Doing this once at startup would break
  // overnight runs once the clock drifts past Google's tolerance window.
  const auth = sapihash(sapisidValue);
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

function existingFor(vid) {
  return fs.readdirSync(OUT_DIR).find(f =>
    f.endsWith('.mp4') && f.includes(vid) &&
    fs.statSync(path.join(OUT_DIR, f)).size > 1024 * 1024
  );
}

function logResult(entry) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch(e) { /* best-effort */ }
}

async function downloadOne(ctx, vid, parentTitle, sapisidValue, au, workerLabel) {
  const existing = existingFor(vid);
  if (existing) {
    const mb = (fs.statSync(path.join(OUT_DIR, existing)).size/1048576).toFixed(1);
    console.log(`${workerLabel} ${vid}: skip (have ${existing}, ${mb} MB)`);
    return { vid, status:'skip' };
  }

  const page = await ctx.newPage();
  try {
    // Park the tab on a Drive page so the playback-API fetch() runs in a Drive origin context
    // with cookies. Without this, fetch() from about:blank fails with "Failed to fetch".
    await page.goto(`https://drive.google.com/u/${au}/`, { waitUntil:'domcontentloaded', timeout:15000 }).catch(()=>{});
    const stream = await getStream(page, vid, sapisidValue, au);
    const safe = (stream.title || `drive_${vid}`).replace(/[\/\\:*?"<>|]/g,'_').slice(0,120);
    const finalOut = path.join(OUT_DIR, safe.endsWith('.mp4') ? safe : safe + '.mp4');
    const out = finalOut + '.part';  // write to .part, rename to .mp4 only on full completion
    console.log(`${workerLabel} ${vid}: start title="${stream.title}" quality=${stream.quality}`);

    const client = await ctx.newCDPSession(page);
    await client.send('Fetch.enable', { patterns:[{ urlPattern:'*videoplayback*', requestStage:'Response' }] });
    const ws = fs.createWriteStream(out);
    let total = 0;
    const t0 = Date.now();
    let streaming = false;

    const done = new Promise((resolve, reject) => {
      client.on('Fetch.requestPaused', async (p) => {
        const s = p.responseStatusCode;
        if (s >= 300 && s < 400) {
          await client.send('Fetch.continueResponse', { requestId:p.requestId }).catch(()=>{});
          return;
        }
        if (s !== 200 && s !== 206) {
          await client.send('Fetch.continueResponse', { requestId:p.requestId }).catch(()=>{});
          return reject(new Error(`HTTP ${s}`));
        }
        if (streaming) {
          await client.send('Fetch.continueResponse', { requestId:p.requestId }).catch(()=>{});
          return;
        }
        streaming = true;
        try {
          const { stream:h } = await client.send('Fetch.takeResponseBodyAsStream', { requestId:p.requestId });
          let eof = false;
          while (!eof) {
            // Stall guard: if a single read takes >5 min, the connection is hung — bail
            // so the worker can grab another file instead of waiting up to 6h for the
            // outer timeout. Re-queued by the retry pass at the end of main.
            const c = await Promise.race([
              client.send('IO.read', { handle:h, size:1024*1024 }),
              new Promise((_,rj)=>setTimeout(()=>rj(new Error('stall: no bytes for 5 min')), 5*60*1000)),
            ]);
            if (c.data) {
              const buf = c.base64Encoded ? Buffer.from(c.data,'base64') : Buffer.from(c.data);
              ws.write(buf); total += buf.length;
            }
            eof = c.eof;
          }
          await client.send('IO.close', { handle:h });
          ws.end();
          resolve(total);
        } catch(e) { ws.end(); reject(e); }
      });
    });

    page.evaluate(async u => { await fetch(u, { credentials:'include' }); }, stream.url).catch(()=>{});
    try {
      // 12h ceiling per file — generous headroom. Real stalls are caught by the 5-min
      // no-bytes guard inside the IO.read loop, so this only fires if Drive sends bytes
      // glacially slowly. 12h is just a sanity backstop.
      await Promise.race([done, new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 12h')), 12*60*60*1000))]);
    } catch (e) {
      // Always delete the .part on failure — leaving it would confuse dedup on retry.
      try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch(_) {}
      throw e;
    }
    // Success: rename .part → .mp4 atomically.
    try { fs.renameSync(out, finalOut); } catch(e) { throw new Error(`rename .part->.mp4 failed: ${e.message}`); }
    const sec = ((Date.now()-t0)/1000).toFixed(0);
    const mb = (total/1048576).toFixed(1);
    console.log(`${workerLabel} ${vid}: done ${mb} MB in ${sec}s`);
    logResult({ ts:new Date().toISOString(), drive_id:vid, status:'ok', title:stream.title||null, parent:parentTitle||null, mb:Number(mb), sec:Number(sec) });
    return { vid, status:'ok', mb:Number(mb) };
  } catch (e) {
    console.error(`${workerLabel} ${vid}: FAIL ${e.message}`);
    logResult({ ts:new Date().toISOString(), drive_id:vid, status:'fail', error:String(e.message||e), title:null, parent:parentTitle||null });
    return { vid, status:'fail', error:String(e.message||e) };
  } finally {
    await page.close().catch(()=>{});
  }
}

(async () => {
  if (!fs.existsSync(PLAN_PATH)) { console.error(`plan not found: ${PLAN_PATH}`); process.exit(2); }
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf-8'));
  const all = plan.videos || (Array.isArray(plan) ? plan : []);
  if (!all.length) { console.error('plan has 0 videos'); process.exit(2); }

  fs.mkdirSync(OUT_DIR, { recursive:true });
  fs.mkdirSync(PROFILE, { recursive:true });

  // Clean up orphaned .part files from any previous failed/killed run.
  // Only one instance of this script should run at a time (Playwright profile lock),
  // so any .part file we see at startup is by definition from a dead run.
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.part')) {
      try { fs.unlinkSync(path.join(OUT_DIR, f)); console.log(`cleaned orphan: ${f}`); } catch(_) {}
    }
  }

  const todo = all.filter(v => !existingFor(v.drive_id));
  const skipped = all.length - todo.length;
  console.log(`Plan: ${all.length} videos. Already on disk: ${skipped}. To download: ${todo.length}. Workers: ${N_WORKERS}`);
  if (!todo.length) { console.log('Nothing to do.'); return; }

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel:'chrome', headless:true,
    args:['--disable-blink-features=AutomationControlled','--no-first-run'],
    viewport:{ width:1280, height:800 },
  });
  const probe = ctx.pages()[0] || await ctx.newPage();
  const au = await findTargetAuthuser(probe);
  if (au < 0) {
    console.error('Target account not signed in. Run scripts/auth_profile.cjs first.');
    await ctx.close(); process.exit(3);
  }
  const cookies = await ctx.cookies('https://drive.google.com');
  const sapisid = cookies.find(c=>c.name==='SAPISID');
  if (!sapisid) { console.error('SAPISID cookie missing'); await ctx.close(); process.exit(5); }
  console.log(`signed in at authuser=${au}`);
  await probe.close().catch(()=>{});

  const MAX_PASSES = 5;  // initial + 4 retries — covers transient network drops over a long unattended run
  let queue = todo.slice();
  let allResults = [];
  for (let pass = 1; pass <= MAX_PASSES && queue.length; pass++) {
    if (pass > 1) console.log(`\n--- retry pass ${pass-1}: ${queue.length} files ---`);
    let idx = 0;
    const results = [];
    const localQueue = queue;
    async function worker(i) {
      const label = `[w${i}${pass>1?'r'+(pass-1):''}]`;
      while (true) {
        const myIdx = idx++;
        if (myIdx >= localQueue.length) return;
        const v = localQueue[myIdx];
        console.log(`${label} taking [${myIdx+1}/${localQueue.length}] ${v.drive_id}`);
        // Re-read cookies in case the session was refreshed mid-run.
        const cs = await ctx.cookies('https://drive.google.com').catch(()=>[]);
        const sap = cs.find(c=>c.name==='SAPISID') || sapisid;
        const r = await downloadOne(ctx, v.drive_id, v.parent || v.title, sap.value, au, label);
        results.push({ v, r });
      }
    }
    const workers = Array.from({length: Math.min(N_WORKERS, localQueue.length)}, (_, i) => worker(i+1));
    await Promise.all(workers);
    allResults = allResults.concat(results.map(x => x.r));
    // Re-queue any failures for the next pass.
    queue = results.filter(x => x.r.status === 'fail').map(x => x.v);
    if (!queue.length) break;
  }

  const ok = allResults.filter(r => r.status==='ok').length;
  const skip = allResults.filter(r => r.status==='skip').length;
  const fail = queue.length;  // anything still in queue after all passes is truly failed
  console.log(`\nFinal: ${ok} ok, ${skip} skipped, ${fail} failed (after ${MAX_PASSES} passes)`);
  if (fail) console.log('still-failed drive_ids:', queue.map(v=>v.drive_id).join(' '));
  await ctx.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL ' + (e.stack || e.message)); process.exit(1); });
