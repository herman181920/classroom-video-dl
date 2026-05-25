#!/usr/bin/env node
// Refresh the persistent Playwright profile's auth (signs you into your Google account).
// Opens a headed Chromium window. Sign in once; the script auto-detects auth
// and exits.
//
// Usage:
//   node auth_profile.cjs        # always opens headed (this script's purpose)
//
// Env:
//   USER_EMAIL          optional: only accept an account whose Google aria-label
//                       contains this substring (case-insensitive). If unset,
//                       any signed-in Google account is accepted.
//   COURSE_DL_PROFILE   optional: persistent Chromium profile directory.
//                       Default: ~/Library/Caches/course-dl/profile (mac)
//                                ~/.cache/course-dl/profile        (Linux)

const { chromium } = require('playwright');
const path = require('path');

const PROFILE = process.env.COURSE_DL_PROFILE
  || path.join(process.env.HOME, process.platform === 'darwin'
       ? 'Library/Caches/course-dl/profile'
       : '.cache/course-dl/profile');

// If USER_EMAIL is set, build a case-insensitive regex from it as a literal
// substring (regex meta chars escaped). If unset, accept any signed-in account.
const TARGET_EMAIL = process.env.USER_EMAIL
  ? new RegExp(process.env.USER_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  : null;

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
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  let au = await findTargetAuthuser(page);
  if (au >= 0) {
    console.log(`already authenticated at authuser=${au}`);
    await ctx.close();
    return;
  }

  console.log('Sign in to your Google account in the browser. Waiting up to 30 min...');
  await page.goto('https://accounts.google.com/AddSession?continue=https://drive.google.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});

  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    try { au = await findTargetAuthuser(page); } catch (e) {}
    if (au >= 0) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  if (au < 0) {
    console.error('Sign-in timeout');
    await ctx.close();
    process.exit(4);
  }
  console.log(`authenticated at authuser=${au}`);
  await ctx.close();
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
