# Troubleshooting

## "Target account not signed in"

The persistent profile doesn't have a valid Google session. Run:

```bash
node scripts/auth_profile.cjs
```

If you're using `USER_EMAIL`, double-check the substring matches your Google Account aria-label.

## "Sign-in timeout"

You didn't complete sign-in within 30 minutes, or 2FA prompted and you missed it. Re-run `auth_profile.cjs`.

## "SAPISID missing"

The session cookies expired. This usually means it's been weeks since you last ran the tool. Re-run `auth_profile.cjs` to refresh.

## Download stalls forever / "stall: no bytes for 5 min"

`download_parallel.cjs` has a built-in 5-minute no-bytes guard — it'll abort the file and re-queue it. If multiple files stall in a row, your network is probably the issue; check your connection and re-run.

## "playback API 403" or "HTTP 401"

The signed-in account doesn't have access to that specific Drive file, or the cookie went stale mid-run. Re-run `auth_profile.cjs` and retry.

## ffprobe flags `SHORT` or `DURMISMATCH`

The download was truncated. Delete the file and re-run the pipeline; dedup will skip everything except the missing one.

## "no items found" / exit 9

You loaded a Classroom URL but the Classwork page rendered empty. Possible causes:

- Wrong course URL.
- Your account doesn't actually have access to that course.
- Classroom's SPA didn't hydrate (rare — re-running usually fixes it).

Check `_scrape_debug.png` and `_scrape_debug.html` that the script wrote next to the output path.

## Chromium opens but I can't sign in

If sign-in fails inside the Playwright-launched Chrome with anti-bot blocks, try:

1. Quit any other Chrome windows.
2. Re-run `auth_profile.cjs`.
3. If still blocked: sign in to Google once in your normal Chrome, then re-run.

## "ENOENT: ... fresh_scrape.json" in the pipeline

The scrape step didn't write its output. Check the scrape's own stderr — usually a Classroom URL issue. The pipeline has `SKIP_SCRAPE=1` mode to retry just the download phase against an existing scrape.

## Where are my downloaded videos?

`./recordings/` at the repo root (or wherever the script's `__dirname/../recordings/` resolves). Each MP4 is named after the video's title (sanitized) and contains the Drive ID for dedup.
