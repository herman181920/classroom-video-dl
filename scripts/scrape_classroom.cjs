#!/usr/bin/env node
// Automate the Google Classroom /t/all scrape using the persistent Playwright
// profile (the same one download_drive_video.cjs uses). Writes the fresh JSON
// to ./fresh_scrape.json by default.
//
// Usage:
//   node scrape_classroom.cjs <COURSE_URL>                     # headless
//   node scrape_classroom.cjs <COURSE_URL> <OUT_PATH>          # custom output path
//   LOGIN=1 node scrape_classroom.cjs <COURSE_URL>             # headed, lets you sign in

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COURSE_URL = (process.argv[2] || '').replace(/\/$/, '');
if (!COURSE_URL) {
  console.error('usage: node scripts/scrape_classroom.cjs <COURSE_URL> [OUT_PATH]');
  console.error('  example: https://classroom.google.com/c/<course-id>');
  process.exit(2);
}
const OUT = path.resolve(process.argv[3] || path.join(process.cwd(), 'fresh_scrape.json'));
const PROFILE = process.env.COURSE_DL_PROFILE
  || path.join(process.env.HOME, process.platform === 'darwin'
       ? 'Library/Caches/course-dl/profile'
       : '.cache/course-dl/profile');
const TARGET_EMAIL = process.env.USER_EMAIL
  ? new RegExp(process.env.USER_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  : null;
const LOGIN_MODE = process.env.LOGIN === '1';

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

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: !LOGIN_MODE,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  let au = await findTargetAuthuser(page);
  if (au < 0) {
    if (!LOGIN_MODE) {
      console.error('Target account not signed in. Re-run with: LOGIN=1 node scripts/scrape_classroom.cjs <COURSE_URL>');
      await ctx.close();
      process.exit(3);
    }
    console.log('Sign in to your Google account in the browser. Waiting up to 30 min...');
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

  // Classroom's React app fails to hydrate via deep-link, and material
  // attachments aren't shown on /t/all anyway — each material has its own
  // detail page. Strategy:
  //   1. Home -> course tile -> Classwork tab (click-driven)
  //   2. Enumerate all material/assignment/question detail URLs + their topic
  //   3. Visit each detail URL and scrape Drive attachments
  const courseId = (COURSE_URL.match(/\/c\/([A-Za-z0-9_-]+)/) || [])[1];
  if (!courseId) { console.error(`Could not parse course id from ${COURSE_URL}`); process.exit(8); }

  // Bootstrap via home + course tile click (deep-link to /t/all fails hydration),
  // then navigate via in-app click to the Classwork tab by URL.
  console.log(`Loading classroom home for authuser=${au}...`);
  await page.goto(`https://classroom.google.com/u/${au}/h`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  console.log(`Clicking course tile for /c/${courseId}...`);
  const courseLinkSel = `a[href*="/c/${courseId}"]`;
  await page.waitForSelector(courseLinkSel, { timeout: 30000 }).catch(() => {});
  await page.evaluate((sel) => {
    const links = Array.from(document.querySelectorAll(sel));
    for (const a of links) {
      const r = a.getBoundingClientRect();
      if (r.width > 50 && r.height > 20) { a.click(); return; }
    }
    if (links[0]) links[0].click();
  }, courseLinkSel);
  await page.waitForTimeout(4000);

  // Now we're on /u/<au>/w/<courseId>. Navigate directly to /t/all from here
  // (works once the SPA shell has booted).
  const tAllUrl = `https://classroom.google.com/u/${au}/w/${courseId}/t/all`;
  console.log(`Navigating to: ${tAllUrl}`);
  await page.goto(tAllUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  console.log(`URL now: ${page.url()}`);

  // Materials are <li data-stream-item-id="..."> rows that expand inline on
  // click to reveal their Drive attachments. Strategy:
  //   1. Enumerate all stream-item ids + their topic context.
  //   2. For each, click the item to expand, then scrape Drive links from
  //      within that LI element.
  console.log('Stage 1: enumerate stream items on /t/all...');
  await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) { window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 1000)); }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(2000);

  const materials = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const li of document.querySelectorAll('li[data-stream-item-id]')) {
      const id = li.getAttribute('data-stream-item-id');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const itemType = li.getAttribute('data-stream-item-type');
      // Walk up to find the nearest preceding h2 (topic header)
      let topic = '';
      let el = li;
      for (let depth = 0; depth < 12 && el; depth++) {
        let sib = el.previousElementSibling;
        while (sib) {
          const h2 = sib.tagName === 'H2' ? sib : sib.querySelector?.('h2');
          if (h2 && h2.innerText.trim()) { topic = h2.innerText.trim().split('\n')[0]; break; }
          sib = sib.previousElementSibling;
        }
        if (topic) break;
        el = el.parentElement;
      }
      const text = (li.innerText || '').trim().replace(/\s+/g, ' ');
      // Title is typically the third "word group" after type + icon
      const titleMatch = text.match(/(?:Material|Question|Assignment|Completed Question|Completed Assignment)\s+\S+\s+(.+?)(?:\s+(?:Posted|Edited|Due|No due date)|$)/);
      const title = titleMatch ? titleMatch[1].trim() : text.slice(0, 80);
      out.push({ id, itemType, topic, title });
    }
    return out;
  });
  console.log(`  found ${materials.length} stream items`);
  if (materials.length === 0) {
    await page.screenshot({ path: path.join(path.dirname(OUT), '_scrape_debug.png'), fullPage: true });
    fs.writeFileSync(path.join(path.dirname(OUT), '_scrape_debug.html'), await page.content(), 'utf8');
    console.error('No stream items found on /t/all. Debug saved.');
    await ctx.close();
    process.exit(9);
  }

  // Stage 2: click each, then scrape Drive links from inside its <li>.
  console.log('Stage 2: expand each item & scrape attachments...');
  const items = [];
  for (let i = 0; i < materials.length; i++) {
    const m = materials[i];
    try {
      const result = await page.evaluate(async (id) => {
        const li = document.querySelector(`li[data-stream-item-id="${CSS.escape(id)}"]`);
        if (!li) return { error: 'li not found' };
        // Find the clickable row (jsaction with click on tdoU3e is the expandable row)
        const clickable = li.querySelector('[jsaction*="click"][jsname="tdoU3e"]')
          || li.querySelector('[jsaction*="click"]')
          || li;
        clickable.click();
        // Wait briefly for the expansion to render
        await new Promise(r => setTimeout(r, 600));
        // Scrape Drive links inside this LI
        const driveRe = /\/(file|document|presentation|spreadsheets)\/d\/([A-Za-z0-9_-]{10,})|\/folders\/([A-Za-z0-9_-]{10,})/;
        const seen = new Set();
        const attachments = [];
        for (const a of li.querySelectorAll('a[href]')) {
          const mm = a.href.match(driveRe);
          if (!mm) continue;
          const did = mm[2] || mm[3];
          if (!did || seen.has(did)) continue;
          seen.add(did);
          let kind = 'drive_file';
          if (a.href.includes('/document/d/')) kind = 'gdoc';
          else if (a.href.includes('/presentation/d/')) kind = 'gslides';
          else if (a.href.includes('/spreadsheets/d/')) kind = 'gsheet';
          else if (a.href.includes('/folders/')) kind = 'drive_folder';
          attachments.push({
            title: (a.innerText || a.getAttribute('aria-label') || '').trim().split('\n')[0] || '(untitled)',
            url: a.href, driveId: did, kind,
          });
        }
        return { attachments };
      }, m.id);

      const attachments = result.attachments || [];
      const compoundTitle = m.topic ? `${m.topic} | ${m.title}` : m.title;
      items.push({
        title: compoundTitle,
        topic: m.topic,
        material_title: m.title,
        stream_item_id: m.id,
        item_type: m.itemType,
        attachments,
      });
      process.stdout.write(`\r  [${i + 1}/${materials.length}] ${m.title.slice(0, 50)} -> ${attachments.length} att        `);
    } catch (e) {
      console.log(`\n  [${i + 1}/${materials.length}] ERROR: ${e.message}`);
      items.push({ title: m.title, topic: m.topic, stream_item_id: m.id, attachments: [], error: e.message });
    }
  }
  console.log('');

  const result = { scraped_at: new Date().toISOString(), course_url: page.url(), items };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  const totalAtt = items.reduce((n, i) => n + (i.attachments?.length || 0), 0);
  console.log(`Scrape OK: ${items.length} items, ${totalAtt} attachments -> ${OUT}`);
  await ctx.close();
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
