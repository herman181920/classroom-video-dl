#!/usr/bin/env node
// One-shot batch downloader: opens Chromium once, downloads every recording
// from videos_plan.json, closes Chromium. Reuses one auth session for all
// downloads (avoids the cookie-invalidation issues seen with the multi-process
// batch wrapper).
//
// Usage:
//   node batch_download_session.cjs                  # default plan path
//   node batch_download_session.cjs path/to/plan.json
//   LOGIN=1 node batch_download_session.cjs ...      # headed for sign-in

const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const PLAN_PATH = path.resolve(process.argv[2] || path.join(PROJECT_ROOT, 'videos_plan.json'));
const OUT_DIR = path.join(PROJECT_ROOT, 'recordings');
const LOG_PATH = path.join(OUT_DIR, '.download_log.jsonl');
const PROFILE = process.env.COURSE_DL_PROFILE
  || path.join(process.env.HOME, process.platform === 'darwin'
       ? 'Library/Caches/course-dl/profile'
       : '.cache/course-dl/profile');
const API_KEY = 'AIzaSyDVQw45DwoYh632gvsP5vPDqEKvb-Ywnb8';
const TARGET_EMAIL = process.env.USER_EMAIL
  ? new RegExp(process.env.USER_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  : null;
const LOGIN_MODE = process.env.LOGIN === '1';

function sapihash(v) {
  const t = Math.floor(Date.now() / 1000);
  return `SAPISIDHASH ${t}_${crypto.createHash('sha1').update(`${t} ${v} https://drive.google.com`).digest('hex')}`;
}

async function findTargetAuthuser(page) {
  for (const au of [0, 1, 2, 3, 4]) {
    try {
      await page.goto(`https://drive.google.com/u/${au}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(800);
      if (page.url().includes('accounts.google.com')) continue;
      if ((await page.title()).includes('404')) continue;
      const aria = await page.evaluate(() => {
        const a = document.querySelector('a[aria-label*="Google Account"]');
        return a && a.getAttribute('aria-label');
      }).catch(() => null);
      if (aria && (!TARGET_EMAIL || TARGET_EMAIL.test(aria))) return au;
    } catch (e) {}
  }
  return -1;
}

async function getStream(page, vid, auth, au) {
  const url = `https://workspacevideo-pa.clients6.google.com/v1/drive/media/${vid}/playback?auditContext=forDisplay&key=${API_KEY}`;
  const d = await page.evaluate(async ({ url, auth, au }) => {
    const r = await fetch(url, { credentials: 'include', headers: { 'Authorization': auth, 'X-Goog-Authuser': String(au) } });
    return { ok: r.ok, status: r.status, body: await r.text() };
  }, { url, auth, au });
  if (!d.ok) throw new Error(`playback API ${d.status}: ${d.body.slice(0, 200)}`);
  const j = JSON.parse(d.body);
  const f = JSON.parse(j.mediaStreamingData.serializedHouseBrandPlayerResponse);
  const formats = f.streamingData.formats || [];
  const fmt = formats.find(x => x.itag === 22) || formats[formats.length - 1];
  return { url: fmt.url, quality: fmt.qualityLabel, title: f.videoDetails && f.videoDetails.title };
}

function alreadyHave(driveId) {
  return fs.readdirSync(OUT_DIR).find(f =>
    f.endsWith('.mp4') && f.includes(driveId) &&
    fs.statSync(path.join(OUT_DIR, f)).size > 1024 * 1024
  );
}

function logResult(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

async function downloadOne(ctx, page, client, driveId, auth, au, plannedTitle) {
  const stream = await getStream(page, driveId, auth, au);
  const safe = (stream.title || `drive_${driveId}`).replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120);
  const out = path.join(OUT_DIR, safe.endsWith('.mp4') ? safe : safe + '.mp4');
  const ws = fs.createWriteStream(out);
  let total = 0, streaming = false;
  const t0 = Date.now();
  const done = new Promise((resolve, reject) => {
    const handler = async (p) => {
      const s = p.responseStatusCode;
      if (s >= 300 && s < 400) {
        await client.send('Fetch.continueResponse', { requestId: p.requestId }).catch(() => {});
        return;
      }
      if (s !== 200 && s !== 206) {
        await client.send('Fetch.continueResponse', { requestId: p.requestId }).catch(() => {});
        return reject(new Error(`HTTP ${s}`));
      }
      if (streaming) {
        await client.send('Fetch.continueResponse', { requestId: p.requestId }).catch(() => {});
        return;
      }
      streaming = true;
      try {
        const { stream: h } = await client.send('Fetch.takeResponseBodyAsStream', { requestId: p.requestId });
        let eof = false;
        while (!eof) {
          const c = await client.send('IO.read', { handle: h, size: 1024 * 1024 });
          if (c.data) {
            const buf = c.base64Encoded ? Buffer.from(c.data, 'base64') : Buffer.from(c.data);
            ws.write(buf); total += buf.length;
            process.stdout.write(`\r    ${(total / 1048576).toFixed(1)} MB`);
          }
          eof = c.eof;
        }
        await client.send('IO.close', { handle: h });
        ws.end();
        client.removeListener('Fetch.requestPaused', handler);
        resolve(total);
      } catch (e) { ws.end(); client.removeListener('Fetch.requestPaused', handler); reject(e); }
    };
    client.on('Fetch.requestPaused', handler);
  });
  page.evaluate(async u => { await fetch(u, { credentials: 'include' }); }, stream.url).catch(() => {});
  await Promise.race([done, new Promise((_, r) => setTimeout(() => r(new Error('timeout 60min')), 60 * 60 * 1000))]);
  console.log(`  done: ${(total / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${path.basename(out)}`);
  return { path: out, bytes: total };
}

(async () => {
  if (!fs.existsSync(PLAN_PATH)) { console.error(`plan not found: ${PLAN_PATH}`); process.exit(2); }
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  const videos = plan.videos || [];
  console.log(`Plan: ${videos.length} videos`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: !LOGIN_MODE,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    viewport: { width: 1280, height: 800 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  let au = await findTargetAuthuser(page);
  if (au < 0) {
    if (!LOGIN_MODE) {
      console.error('Target account not signed in. Re-run with: LOGIN=1 node scripts/batch_download_session.cjs');
      await ctx.close(); process.exit(3);
    }
    console.log('Sign in to your Google account (waiting up to 30 min)...');
    await page.goto('https://accounts.google.com/AddSession?continue=https://drive.google.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    const dl = Date.now() + 30 * 60 * 1000;
    while (Date.now() < dl) {
      try { au = await findTargetAuthuser(page); } catch (e) {}
      if (au >= 0) break;
      await new Promise(r => setTimeout(r, 5000));
    }
    if (au < 0) { console.error('Sign-in timeout.'); await ctx.close(); process.exit(4); }
  }
  console.log(`signed in at authuser=${au}`);

  const cookies = await ctx.cookies('https://drive.google.com');
  const sapisid = cookies.find(c => c.name === 'SAPISID');
  if (!sapisid) { console.error('SAPISID missing'); await ctx.close(); process.exit(5); }
  const auth = sapihash(sapisid.value);

  const client = await ctx.newCDPSession(page);
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*videoplayback*', requestStage: 'Response' }] });

  let ok = 0, skip = 0, fail = 0;
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    console.log(`\n[${i + 1}/${videos.length}] ${v.drive_id} — ${v.title || ''}`);
    const have = alreadyHave(v.drive_id);
    if (have) { console.log(`  skip (already have ${have})`); skip++; continue; }
    try {
      const r = await downloadOne(ctx, page, client, v.drive_id, auth, au, v.title);
      logResult({ ts: new Date().toISOString(), drive_id: v.drive_id, status: 'ok', bytes: r.bytes, file: path.basename(r.path) });
      ok++;
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      logResult({ ts: new Date().toISOString(), drive_id: v.drive_id, status: 'fail', error: e.message });
      fail++;
    }
  }

  await ctx.close();
  console.log(`\nDone: ${ok} downloaded, ${skip} skipped, ${fail} failed (of ${videos.length})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
