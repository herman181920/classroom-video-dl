# classroom-video-dl

Download videos from a Google Classroom course you have access to. Works in headless Chromium via Playwright; no manual cookie copying.

> Designed to be set up by an AI coding agent. Tell Claude Code, Codex, or Cursor: _"set up classroom-video-dl and download my course videos"_ — it reads `AGENTS.md` and walks you through sign-in and download.

## What it does

Given a Google Classroom course URL and your sign-in, it:

1. Scrapes the **Classwork** page for every video attachment.
2. Filters to videos (keyword/extension match — covers English and Hebrew terms).
3. Downloads each video at the highest available quality, in parallel.
4. Verifies every MP4 with `ffprobe` (flags truncations, missing audio, etc.).

It uses the same Drive playback API your browser uses, with auth proxied through a persistent Playwright profile. No bypass of access controls — you only get what your account can already see.

## Quick start

```bash
# 1. Install
git clone https://github.com/<user>/classroom-video-dl
cd classroom-video-dl
npm install
npx playwright install chromium

# 2. Sign in (one-time — Chromium opens, you sign into Google manually)
node scripts/auth_profile.cjs

# 3. Run the full pipeline against your course
./scripts/run_video_pipeline.sh "https://classroom.google.com/c/<course-id>"
```

MP4s land in `./recordings/`. The pipeline skips files already on disk, so re-running it is safe.

## Step-by-step (if you prefer)

```bash
node scripts/auth_profile.cjs                                          # one-time sign-in
node scripts/scrape_classroom.cjs "<COURSE_URL>" fresh_scrape.json     # scrape
python3 scripts/plan_videos.py fresh_scrape.json videos_plan.json      # filter to videos
node scripts/batch_download_session.cjs videos_plan.json               # download (sequential)
# or, for parallel:
N=3 node scripts/download_parallel.cjs videos_plan.json
python3 scripts/verify_recordings.py                                   # ffprobe sanity check
```

## Environment variables

| Var                 | Purpose                                                                                       | Default                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `USER_EMAIL`        | Match a specific signed-in Google account (substring of the account's aria-label, case-insensitive). Useful if you have multiple Google accounts. | unset — accepts the first signed-in account                                            |
| `COURSE_DL_PROFILE` | Persistent Playwright profile directory.                                                       | `~/Library/Caches/course-dl/profile` (macOS), `~/.cache/course-dl/profile` (Linux)     |
| `LOGIN`             | Force a headed Chromium window (used implicitly by `auth_profile.cjs`).                        | unset (headless)                                                                       |
| `N`                 | Parallel download workers in `download_parallel.cjs`.                                          | `3`                                                                                    |
| `SKIP_SCRAPE`       | In the pipeline, reuse an existing `fresh_scrape.json` instead of re-scraping.                 | unset                                                                                  |
| `PY`                | Python interpreter used by the pipeline shell wrapper.                                         | `python3`                                                                              |

## Prerequisites

- Node.js ≥ 20
- Python ≥ 3.10 (stdlib only — no `pip install` needed)
- `ffmpeg` / `ffprobe` on `$PATH`
- `jq` (used by the pipeline wrapper)
- Disk space for the videos (~5–20 GB depending on course)

Install on macOS: `brew install node python ffmpeg jq`.

## How it works

Each video on Google Classroom links to a Drive file. Drive's video player uses an internal playback API (`workspacevideo-pa.clients6.google.com/v1/drive/media/<id>/playback`) that returns signed MP4 URLs. The downloader calls that API with a `SAPISIDHASH` Authorization header (the same auth your browser tab uses), then streams the bytes through Chrome DevTools Protocol's `Fetch.takeResponseBodyAsStream` to disk. Auth state lives in a persistent Playwright profile so you only sign in once.

Longer write-up: see [`docs/how-it-works.md`](docs/how-it-works.md).

## Privacy & security

- **No access bypass.** This tool downloads only videos your authenticated Google account already has permission to view.
- **Profile dir = session cookies.** `$COURSE_DL_PROFILE` (default `~/Library/Caches/course-dl/profile`) holds your Google login state. Treat it like a password — don't share, don't commit.
- **`USER_EMAIL` is a substring match**, not a regex. Regex meta chars are escaped before use.
- **No telemetry, no network calls** beyond Google's own Classroom / Drive endpoints.

## For AI coding agents

See [`AGENTS.md`](AGENTS.md) for the runbook — what to ask the user for, what each command outputs, exit-code interpretation, and the explicit "I cannot drive the sign-in window" handoff to the human.

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md).

## License

[Apache-2.0](LICENSE). See [`NOTICE`](NOTICE).

## Acknowledgments

The Drive playback API + CDP-streaming approach was developed during a personal project to mirror a Google Classroom course. Cleaned up and released so other students can reuse it.
