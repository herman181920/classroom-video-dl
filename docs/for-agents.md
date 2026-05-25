# For agents (deep dive)

Companion to `AGENTS.md`. Read this when something doesn't go as scripted.

## What the scripts implicitly assume

- `process.env.HOME` is set (universal on macOS/Linux).
- `chromium` channel is installed (covered by `npx playwright install chromium`).
- The default profile dir is writable.
- `ffmpeg` / `ffprobe` are on `$PATH` (only relevant for `verify_recordings.py`).
- `jq` is on `$PATH` (only relevant for `run_video_pipeline.sh`).

If any of those don't hold, the failure mode is usually a clean error message — read stderr.

## Sign-in detection model

`findTargetAuthuser()` iterates `https://drive.google.com/u/0..4/`. For each, it:

1. Skips if redirected to `accounts.google.com` (not signed in there).
2. Skips if the page title contains `404` (no account at that authuser slot).
3. Reads the Google Account `aria-label` from the top-right icon.
4. If `USER_EMAIL` is set, checks the aria-label against the regex.
5. Returns the first matching `authuser`.

`-1` means no signed-in account matched. That's exit code 3 (`download_drive_video.cjs` / `download_parallel.cjs`) or triggers headed login if `LOGIN=1`.

## What `LOGIN=1` does

In `scrape_classroom.cjs`, `download_drive_video.cjs`, `batch_download_session.cjs`: opens Chromium headed and waits up to 30 minutes for the user to sign in. Polls for sign-in detection every few seconds. `auth_profile.cjs` is always headed (that's its purpose) and doesn't need `LOGIN=1`.

## Streaming model (downloads)

Each download is a CDP-intercepted byte stream:

1. Worker tab navigates to `drive.google.com/u/<au>/` (gives the page a Drive-origin context for fetch).
2. Worker calls the playback API; gets a signed `videoplayback` URL.
3. Worker enables CDP `Fetch.enable` with pattern `*videoplayback*` (response stage).
4. Worker triggers a `fetch(<url>)` inside the page — this hits the network.
5. CDP intercepts the response (200 or 206), takes the body stream via `Fetch.takeResponseBodyAsStream`, and pumps bytes to disk in 1 MB reads.
6. On EOF, the `.part` file is renamed to `.mp4` atomically.

Failure modes:
- 3xx redirect → let it pass through; the redirected request triggers the handler again.
- Non-200/206 → reject the promise; worker logs and moves on.
- 5-min stall (no bytes from a single `IO.read`) → reject and re-queue.
- 12-hour wall-clock per file → backstop.

## Parallel worker model

`download_parallel.cjs`:

- One Chromium context, N tabs.
- Shared queue (in-memory array + atomic index counter).
- Cookies re-read per file in case Google rotated the session.
- 5 passes total: initial + 4 retries. Anything still failing after pass 5 is reported.

## Dedup logic

A file is considered "already downloaded" if any `.mp4` in `./recordings/` has the Drive ID as a substring of its filename AND is larger than 1 MB. This handles both the title-based naming (`<safe_title>.mp4`) and the fallback naming (`drive_<id>.mp4`).

## Where state lives

| Path | Purpose | Sensitive? |
| ---- | ------- | ---------- |
| `$COURSE_DL_PROFILE` | Persistent Chromium profile (Google session cookies) | **YES** — treat as a password |
| `./recordings/` | Downloaded MP4s | Their content is course material the user owns access to |
| `./recordings/.download_log.jsonl` | Per-file download outcomes | No |
| `./fresh_scrape.json` | Latest Classroom scrape | Contains course title + attachment titles |
| `./videos_plan.json` | Filtered video download plan | Same as above |

## Common edge cases

- **Multi-account users.** If the user has multiple Google accounts signed into Chromium, `findTargetAuthuser` returns the first matching `authuser`. Set `USER_EMAIL` to disambiguate.
- **Hebrew course titles.** The keyword filter in `plan_videos.py` / `diff_and_plan.py` matches `"הקלטה"` and `"הקלטת"` — language coverage is intentional. Don't strip them.
- **Course re-orgs.** If the user has run the tool before and the course has been reorganized, `course_map.json` (if they have one) lets `merge_legacy_recordings.py` pull in items that were removed from Classroom but still exist in Drive. Fresh users won't have this file — the pipeline skips this step gracefully.

## Reading the download log

`./recordings/.download_log.jsonl` is one JSON object per line:

```json
{"ts":"2026-05-25T12:34:56Z","drive_id":"abc...","status":"ok","title":"...","parent":"...","mb":248.3,"sec":127}
{"ts":"2026-05-25T12:36:11Z","drive_id":"def...","status":"fail","error":"HTTP 403","title":null,"parent":"..."}
```

`status` is `ok`, `fail`, or `skip` (already on disk).
