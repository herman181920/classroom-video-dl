# AGENTS.md — instructions for AI coding agents

You're reading this because a human cloned `classroom-video-dl` and asked you to set it up and run it. This file is your runbook.

## What the user wants

To download all video recordings from a specific Google Classroom course onto their local machine, ending up with `.mp4` files in `./recordings/`.

## How this tool works (short version)

Each lecture in Google Classroom is a Google Drive file. Drive's video player calls an internal API (`workspacevideo-pa.clients6.google.com/.../playback`) that returns signed MP4 URLs. This tool replicates that call from a persistent Playwright Chromium profile (which holds the user's Google session cookies), gets the signed URL, and pipes the bytes to disk through Chrome DevTools Protocol's `Fetch.takeResponseBodyAsStream`. No yt-dlp, no cookie scraping from the user's main browser — Playwright manages its own Chromium with its own profile dir.

**Pipeline stages (in order):**

1. **auth** — open Chromium headed, user signs into Google (one-time human handoff).
2. **scrape** — Playwright walks Classroom's Classwork page (`/t/all`), clicks each material to expand it, harvests Drive links.
3. **plan** — Python filter keeps only video-keyworded attachments (English + Hebrew terms, plus `.mp4/.mov/.m4v` extensions).
4. **download** — parallel CDP-streamed downloads; `.part` files for safety, atomic rename on success, 5-pass retries, dedup by Drive ID.
5. **verify** — ffprobe sanity-checks every MP4 against the plan.

If you understand this much, you can debug most failure modes. The exit-code table below maps stage-specific failures to remediation.

## What you need to ask the human

**Course URL.** A link like `https://classroom.google.com/c/<course-id>` — the course they want videos from. They have to have access to it themselves; this tool doesn't bypass anything.

If you can't infer it from context, ask: _"What's the Google Classroom course URL you want videos from?"_

Optional: ask if they have multiple Google accounts. If yes, ask for the email substring and export `USER_EMAIL`.

## Prerequisites check

Before doing anything, verify these are installed. If any are missing, install them (`brew install` on macOS; package-manager equivalent on Linux) or ask the user to:

| Tool | Check | Min version |
| ---- | ----- | ----------- |
| Node | `node -v` | 20+ |
| Python | `python3 --version` | 3.10+ |
| ffmpeg/ffprobe | `ffprobe -version` | any recent |
| jq | `jq --version` | any |

## One-time setup

```bash
npm install
npx playwright install chromium
```

`npx playwright install chromium` downloads ~150 MB. It's idempotent — safe to re-run.

## The sign-in handoff (read carefully)

The next step opens a **visible** Chromium window where the user must sign in to Google. **You cannot drive this window** — Google has anti-bot detection, and even if you could, you shouldn't.

When you run `node scripts/auth_profile.cjs`:

1. **Tell the user** something like: _"A Chromium window will open. Please sign in to the Google account that has access to your course. Don't close the window — the script auto-detects sign-in and exits."_
2. **Wait** for the process to exit. It exits `0` on success, `4` on timeout, `1` on fatal error.
3. **Do NOT** try to interact with the window via screenshots, computer-use tools, or anything else.
4. **Do NOT** try to copy cookies from the user's main Chrome browser — macOS Keychain blocks this from agent shells, and even on Linux it tends to break.

If the user already signed in once, `auth_profile.cjs` detects the existing profile and exits immediately. Skip the handoff text in that case.

**Important: bash timeout.** After printing the initial sign-in prompt, the script polls silently every 5 seconds until sign-in is detected. Stdout stays quiet — that is **not a hang**. The script itself waits up to 30 minutes for the user.

**If your tooling defaults to a short bash timeout, override it to at least 10 minutes for this command.** Claude Code: pass `timeout: 600000` (ms) on the Bash tool call. Codex / Cursor / others: use their equivalent. Otherwise your wrapper will cut off before the human finishes signing in, even though the script itself is fine.

The same long-timeout rule applies to any command run with `LOGIN=1` headed mode.

## The workflow

```bash
node scripts/auth_profile.cjs                                # sign-in handoff (see above)
./scripts/run_video_pipeline.sh "<COURSE_URL>"               # full pipeline
```

Or step-by-step if you want finer control:

```bash
node scripts/scrape_classroom.cjs "<URL>" fresh_scrape.json
python3 scripts/plan_videos.py fresh_scrape.json videos_plan.json
node scripts/batch_download_session.cjs videos_plan.json     # sequential
#  - or -
N=3 node scripts/download_parallel.cjs videos_plan.json      # parallel, 3 workers
python3 scripts/verify_recordings.py
```

## Exit codes

| Code | Meaning | What to do |
| ---: | ------- | ---------- |
| 0 | Success | Continue. |
| 1 | Generic fatal | Read stderr; usually a script bug or unexpected state. |
| 2 | Bad/missing CLI args | Read the usage message printed by the script. |
| 3 | Not signed in | Run `node scripts/auth_profile.cjs` (sign-in handoff). |
| 4 | Sign-in timeout | User didn't sign in within 30 min. Re-run auth. |
| 5 | SAPISID cookie missing | Session expired. Re-run `auth_profile.cjs`. |
| 6 | Drive playback API failure | Video may be restricted, or the cookie went stale mid-run. Re-run auth, retry. |
| 7 | Per-file download timeout (12 h) | Bandwidth or network issue. Re-run; downloads resume via dedup. |
| 9 | No items found on Classroom page | User may not actually have access to that course, or the URL is wrong. |

## Things that look weird but are normal

Don't escalate these to the user as errors — they're expected:

- **`title=undefined` in download logs.** Drive's playback API sometimes omits `videoDetails.title`. The downloader falls back to `drive_<id>.mp4`. Dedup still works (it matches Drive ID substring in the filename).
- **Two `.mp4`s per lecture.** Some Classroom items attach a backup recording with a different Drive ID. Both will download — that's intentional.
- **Silent stdout during sign-in.** See the bash-timeout note above.
- **Hebrew lecture titles.** The plan filter recognizes Hebrew video keywords (`הקלטה`, `הקלטת`) by design. English-only courses just never see them.
- **First run downloads ~150 MB.** That's `npx playwright install chromium` fetching the bundled browser. Subsequent runs are fast.
- **`No items found` on first scrape after `LOGIN=1`.** Occasionally Classroom's React app doesn't fully hydrate. Re-run; almost always works second time.

## What NOT to do

- ❌ Don't interact with the visible Chromium sign-in window.
- ❌ Don't copy cookies from the user's main browser.
- ❌ Don't delete or modify `$COURSE_DL_PROFILE` — that's the persistent Google session.
- ❌ Don't commit any of: `fresh_scrape.json`, `videos_plan.json`, `recordings/`, `.env`. The `.gitignore` covers these.
- ❌ Don't change the `API_KEY` constant in the .cjs files — it's the public Drive web client key and the playback API expects it.

## Final report to the user

After the pipeline finishes, report:

- How many MP4s landed in `./recordings/` and the total size.
- Anything `verify_recordings.py` flagged (SHORT / NOAUDIO / NOVIDEO / DURMISMATCH / MISSING).
- The path to the download log: `./recordings/.download_log.jsonl`.

## Deep dive

If you hit something unexpected, read [`docs/for-agents.md`](docs/for-agents.md). It explains the Drive playback API, SAPISIDHASH, CDP streaming, the parallel worker model, and the file-skip / retry logic in enough depth to debug effectively.
