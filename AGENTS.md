# Agent instructions

This repository downloads video attachments from a Google Classroom course. Read the [README](README.md) before running it.

## Inputs and setup

1. Get the course URL from the user. Do not guess a course ID.
2. Check for Node.js 20+, Python 3.10+, `ffprobe`, and `jq`.
3. Run `npm install` and `npx playwright install chromium` if needed.
4. Run `node scripts/auth_profile.cjs`. The user signs in to the opened Chromium window. Wait for the command to exit.

Set `USER_EMAIL` when the user has multiple signed-in Google accounts.

## Run and verify

```bash
./scripts/run_video_pipeline.sh "<COURSE_URL>"
python3 scripts/verify_recordings.py
```

The pipeline saves MP4s in `recordings/`. Report the count, total size, verification failures, and the download log at `recordings/.download_log.jsonl`.

Do not commit browser profiles, recordings, scrape results, or credentials. The `.gitignore` excludes normal runtime outputs. For implementation details, see [docs/for-agents.md](docs/for-agents.md).
