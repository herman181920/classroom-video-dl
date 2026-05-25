"""ffprobe every .mp4 in ./recordings/ and flag issues.

Usage:
    python3 scripts/verify_recordings.py

Reports per-file duration / size / streams. Cross-checks against
videos_plan.json (if present): every plan entry should have a matching mp4
on disk that contains its Drive ID in its filename. Flags:
  - missing — plan drive_id has no on-disk file
  - short — duration < 60s (likely a stub)
  - noaudio / novideo — stream missing
  - durmismatch — container header vs decoded audio diverge > 1.5x

Exit code: 0 if everything looks OK, 1 if anything is flagged.
"""

import json
import subprocess
import sys
from pathlib import Path

RECORDINGS = Path(__file__).resolve().parent.parent / "recordings"
PLAN = Path(__file__).resolve().parent.parent / "videos_plan.json"
SUSPICIOUS_MIN_SECONDS = 60.0
HEADER_VS_DECODE_TOLERANCE_RATIO = 1.5  # header / actual diverging by more than 1.5x is suspect


def ffprobe_streams(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        return {"error": out.stderr.strip()}
    return json.loads(out.stdout)


def actual_audio_duration(path: Path) -> float | None:
    """Decode the audio stream and report its real duration (seconds)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "packet=pts_time",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=False,
    )
    if out.returncode != 0 or not out.stdout.strip():
        return None
    last = None
    for line in out.stdout.splitlines():
        line = line.strip().rstrip(",")
        if line:
            try:
                last = float(line)
            except ValueError:
                pass
    return last


def fmt_dur(secs: float) -> str:
    h, rem = divmod(int(secs), 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m}m{s:02d}s"


def main() -> int:
    if not RECORDINGS.exists():
        print(f"no recordings dir: {RECORDINGS}", file=sys.stderr)
        return 2
    files = sorted(RECORDINGS.glob("*.mp4"))
    if not files:
        print("no .mp4 files in recordings dir")
        return 0

    # Cross-check against plan (if present)
    plan_videos: list[dict] = []
    if PLAN.exists():
        plan_videos = json.loads(PLAN.read_text(encoding="utf-8")).get("videos", [])

    issues = 0
    print(f"{'flag':<12} {'header_dur':>11} {'actual_dur':>11} {'size':>8}  file")
    print("-" * 105)
    for f in files:
        info = ffprobe_streams(f)
        if "error" in info:
            print(f"{'ERR':<5} {'-':>11} {'-':>11} {f.stat().st_size/1048576:>6.0f}M  {f.name}")
            issues += 1
            continue

        header_dur = float(info.get("format", {}).get("duration", 0) or 0)
        size_mb = int(info.get("format", {}).get("size", 0) or 0) / 1048576
        streams = info.get("streams", [])
        has_audio = any(s.get("codec_type") == "audio" for s in streams)
        has_video = any(s.get("codec_type") == "video" for s in streams)

        actual_dur = actual_audio_duration(f) if has_audio else None

        flags = []
        if header_dur < SUSPICIOUS_MIN_SECONDS:
            flags.append("SHORT")
        if not has_audio:
            flags.append("NOAUDIO")
        if not has_video:
            flags.append("NOVIDEO")
        if actual_dur and header_dur > 0:
            ratio = max(header_dur, actual_dur) / max(min(header_dur, actual_dur), 0.1)
            if ratio > HEADER_VS_DECODE_TOLERANCE_RATIO:
                flags.append("DURMISMATCH")
        flag_str = ",".join(flags) if flags else "ok"
        if flags:
            issues += 1
        actual_str = fmt_dur(actual_dur) if actual_dur is not None else "-"
        print(f"{flag_str:<12} {fmt_dur(header_dur):>11} {actual_str:>11} {size_mb:>6.0f}M  {f.name}")

    # Plan coverage check — every plan drive_id should appear in some filename.
    if plan_videos:
        print()
        print("--- plan coverage ---")
        ondisk = " ".join(f.name for f in files)
        missing = [v for v in plan_videos if v.get("drive_id") and v["drive_id"] not in ondisk]
        for v in missing:
            print(f"MISSING  {v['drive_id']:50}  {v.get('title', '')}")
            issues += 1
        print(f"plan: {len(plan_videos)} videos, on-disk: {len(plan_videos) - len(missing)}, missing: {len(missing)}")

    print()
    print(f"{len(files)} files, {issues} flagged")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
