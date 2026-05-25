#!/usr/bin/env bash
# End-to-end Google Classroom recordings pipeline.
#
# 1. Scrape /t/all in Google Classroom (via Playwright + signed-in profile)
# 2. Plan recording downloads from the fresh scrape
# 3. Merge legacy recordings from course_map.json (covers items removed
#    from Classroom but still in Drive) — skipped if no course_map.json
# 4. Batch-download every recording (skips files already on disk)
# 5. Verify each .mp4 with ffprobe (flags truncations / missing audio)
#
# Usage:
#   ./scripts/run_video_pipeline.sh "<classroom-course-url>"
#   SKIP_SCRAPE=1 ./scripts/run_video_pipeline.sh "<url>"   # re-use existing fresh_scrape.json
#   LOGIN=1       ./scripts/run_video_pipeline.sh "<url>"   # headed sign-in for the scrape
#
# Prereqs: ffmpeg, jq, node, the Playwright profile authenticated to your
# Google account (run `node scripts/auth_profile.cjs` once if not).

set -u

COURSE_URL="${1:-}"
if [[ -z "$COURSE_URL" ]]; then
  echo "usage: $0 <classroom-course-url>" >&2
  echo "  example: $0 'https://classroom.google.com/c/<course-id>'" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PY="${PY:-python3}"
DATA="$ROOT"
SCRAPE="$DATA/fresh_scrape.json"
PLAN="$DATA/videos_plan.json"
LEGACY="$DATA/course_map.json"

echo "==> Step 1/5: scrape Google Classroom"
if [[ "${SKIP_SCRAPE:-0}" != "1" ]]; then
  node "$SCRIPT_DIR/scrape_classroom.cjs" "$COURSE_URL" "$SCRAPE" || { echo "scrape failed"; exit 1; }
else
  echo "  (skipped — using existing $SCRAPE)"
fi

echo ""
echo "==> Step 2/5: build video plan from fresh scrape"
"$PY" "$SCRIPT_DIR/plan_videos.py" "$SCRAPE" "$PLAN" || { echo "plan failed"; exit 1; }

echo ""
echo "==> Step 3/5: merge legacy recordings from course_map.json"
if [[ -f "$LEGACY" ]]; then
  "$PY" "$SCRIPT_DIR/merge_legacy_recordings.py" "$PLAN" "$LEGACY" "$PLAN.tmp" \
    && mv "$PLAN.tmp" "$PLAN" \
    || { echo "merge failed"; exit 1; }
else
  echo "  (no $LEGACY found — skipping legacy merge)"
fi

count=$(jq '.videos | length' "$PLAN")
echo "  Plan now has $count videos."

echo ""
echo "==> Step 4/5: batch download in one Chromium session (skips already-present files)"
node "$SCRIPT_DIR/batch_download_session.cjs" "$PLAN" || echo "(some downloads failed — see log)"

echo ""
echo "==> Step 5/5: verify recordings"
"$PY" "$SCRIPT_DIR/verify_recordings.py" || echo "(some files flagged — see report)"

echo ""
echo "Pipeline done. Outputs:"
echo "  Plan        : $PLAN"
echo "  Recordings  : $DATA/recordings/"
echo "  Download log: $DATA/recordings/.download_log.jsonl"
