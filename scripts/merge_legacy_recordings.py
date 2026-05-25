"""Augment a video plan with recording entries from legacy course_map.json.

The fresh scrape only shows what's currently on /t/all in Google Classroom.
Older recordings that have been removed from Classroom may still be in
course_map.json (last full scrape) and reachable via their Drive IDs.

Usage:
    python merge_legacy_recordings.py <existing_plan.json> <legacy_course_map.json> <out_plan.json>

Adds any recording-type attachment from course_map.json that's not already in
the plan (deduped by drive_id). Marked with `source: "legacy"` for traceability.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from diff_and_plan import category_for  # noqa: E402


def main() -> None:
    if len(sys.argv) != 4:
        print("usage: merge_legacy_recordings.py <plan.json> <course_map.json> <out.json>", file=sys.stderr)
        sys.exit(2)

    plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    legacy = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))

    existing_ids = {v["drive_id"] for v in plan.get("videos", []) if v.get("drive_id")}
    added: list[dict] = []

    # course_map.json's `files` list is the legacy dedicated recordings index.
    for f in legacy.get("files", []):
        if f.get("category") != "recordings":
            continue
        drive_id = f.get("drive_id") or f.get("driveId")
        if not drive_id or drive_id in existing_ids:
            continue
        existing_ids.add(drive_id)
        added.append({
            "drive_id": drive_id,
            "title": f.get("title") or "(untitled)",
            "parent": f.get("parent_material") or "",
            "kind": "drive_file",
            "source": "legacy",
        })

    # Also scan stream_items[*].attachments for any drive_file recordings that
    # might have been categorized inline (the older scraper format).
    for item in legacy.get("stream_items", []):
        parent = item.get("title", "")
        for att in item.get("attachments", []):
            if category_for(att, parent) != "recordings":
                continue
            drive_id = att.get("driveId") or att.get("drive_id")
            if not drive_id or drive_id in existing_ids:
                continue
            existing_ids.add(drive_id)
            added.append({
                "drive_id": drive_id,
                "title": att.get("title") or "(untitled)",
                "parent": parent,
                "kind": att.get("kind") or "drive_file",
                "source": "legacy",
            })

    plan["videos"].extend(added)
    Path(sys.argv[3]).write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"merged: +{len(added)} legacy recordings, total {len(plan['videos'])} videos -> {sys.argv[3]}", file=sys.stderr)


if __name__ == "__main__":
    main()
