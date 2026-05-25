# How it works

A walk-through of the moving parts, for anyone curious or debugging.

## The auth layer — persistent Playwright profile

`auth_profile.cjs` launches Chromium with `chromium.launchPersistentContext(PROFILE, ...)`. The `PROFILE` directory (default `~/Library/Caches/course-dl/profile`) holds cookies, local storage, IndexedDB, and the rest of the browser state. Once you sign into Google there, every subsequent invocation of any script in this repo re-uses that state.

We probe the signed-in account by iterating `https://drive.google.com/u/{0..4}/` and reading the Google Account `aria-label`. The first one that resolves (and matches `USER_EMAIL` if set) wins — that's the `authuser` value passed to the playback API.

## The download trick — Drive's internal playback API + CDP

When you watch a Drive video in your browser, the player makes a request to:

```
POST https://workspacevideo-pa.clients6.google.com/v1/drive/media/<DRIVE_ID>/playback?auditContext=forDisplay&key=<PUBLIC_KEY>
```

with two important headers:

- `Authorization: SAPISIDHASH <timestamp>_<sha1>` — computed from the `SAPISID` cookie via `sha1(timestamp + ' ' + cookie + ' https://drive.google.com')`. This is the same scheme Google's web apps use internally.
- `X-Goog-Authuser: <N>` — the `authuser` we probed earlier.

The response contains a `serializedHouseBrandPlayerResponse` JSON blob with the streaming MP4 URLs at various quality levels. We pick the highest available (preferring `itag=22`, which is 720p H.264 on Drive's video pipeline) and load it.

But we don't just fire `wget`. The signed URL only works inside an authenticated browser context, and the bytes come back chunked. So we attach a CDP session to the page and enable `Fetch.requestPaused` with the pattern `*videoplayback*`. The browser fetches the URL; we intercept the response, take ownership of the body stream via `Fetch.takeResponseBodyAsStream`, and pump it through Node's filesystem APIs straight to disk. No re-encoding, no memory bloat.

## The scrape layer — Classroom DOM walking

Google Classroom is a React SPA. Deep-linking directly to `/u/<au>/w/<courseId>/t/all` consistently fails to hydrate, so `scrape_classroom.cjs` follows a deliberate click path:

1. Load `/u/<au>/h` (Classroom home).
2. Click the course tile.
3. Navigate to `/t/all` via in-app routing.

Once `/t/all` renders, every material is a `<li data-stream-item-id="...">`. We enumerate them, then click each one to expand its inline attachment list, and harvest the Drive links from inside that `<li>`.

Topic context comes from walking back to the nearest preceding `<h2>` — Classroom renders topic headers as siblings rather than parents.

## The plan layer — keyword filter

`plan_videos.py` reads the scrape JSON and keeps only attachments whose title/parent matches a video keyword (`recording`, `video`, `playback`, `youtube`, and Hebrew equivalents) or has a video file extension (`.mp4`, `.mov`, `.m4v`). Everything else gets logged under `skipped`.

`diff_and_plan.py` provides the underlying `category_for()` heuristic that `plan_videos.py` imports.

## The parallel downloader

`download_parallel.cjs` opens one Chromium context, then spawns N worker tabs (default 3) that each pull from a shared in-memory queue. Each tab parks itself on `drive.google.com/u/<au>/` (the playback API rejects fetches from `about:blank`), gets the streaming URL, sets up its own CDP fetch interception, and streams to a `.part` file. On success the `.part` is renamed to `.mp4` atomically. On failure the `.part` is deleted so dedup on retry is clean.

Retries: up to 5 passes total. Anything still failing after pass 5 is reported in stdout and the download log.

## The verify layer — ffprobe sanity check

`verify_recordings.py` walks `./recordings/*.mp4` and ffprobes each one. Flags:

- `SHORT` — header duration < 60 s (likely a stub).
- `NOAUDIO` / `NOVIDEO` — stream missing.
- `DURMISMATCH` — container-header duration vs. decoded-audio duration diverge by >1.5×.
- `MISSING` — a plan entry has no on-disk file whose name contains the Drive ID.

Exit `0` if everything is clean, `1` if anything flagged.

## Why not yt-dlp?

yt-dlp's Google Drive handler often fails for restricted-permission course videos — the kind your school grants you but doesn't let you "Download" via the right-click menu. The internal playback API + CDP stream sidesteps the download-permission check entirely (Drive lets you _watch_, we just record what comes down the wire).
