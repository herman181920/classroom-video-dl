"""Diff a freshly-scraped classroom dump against the existing course_map.json
and emit a download plan for new items only.

Inputs:
  - existing course_map.json (path arg 1)
  - fresh scrape JSON (path arg 2) produced by scrape_classwork.js
Outputs:
  - prints a JSON download plan: list of {driveId, title, kind, parent_material, dest_path}
  - filters out video/recording categories (user only wants slides/notebooks/written material)
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

VIDEO_KEYWORDS = (
    "recording", "הקלטה", "הקלטת", "video", "playback", "youtube",
)
KIND_TO_CATEGORY = {
    "drive_file": "documents",   # refined later by extension
    "gdoc": "documents",
    "gslides": "presentations",
    "gsheet": "documents",
    "drive_folder": "folders",
    "external": "other",
}
EXT_TO_CATEGORY = {
    ".ipynb": "notebooks",
    ".pptx": "presentations",
    ".pdf": "documents",
    ".docx": "documents",
    ".doc": "documents",
    ".xlsx": "documents",
    ".csv": "documents",
    ".txt": "documents",
    ".md": "documents",
    ".png": "other",
    ".jpg": "other",
    ".jpeg": "other",
    ".mp4": "recordings",
    ".mov": "recordings",
    ".m4v": "recordings",
}


def safe_filename(name: str) -> str:
    name = unicodedata.normalize("NFC", name)
    name = re.sub(r"[\\/:*?\"<>|]+", "_", name).strip()
    return name or "untitled"


def category_for(att: dict, parent_title: str) -> str:
    title = att.get("title", "") or ""
    parent = parent_title or ""
    text = f"{title} {parent}".lower()
    if any(k in text for k in VIDEO_KEYWORDS):
        return "recordings"
    for ext, cat in EXT_TO_CATEGORY.items():
        if title.lower().endswith(ext):
            return cat
    return KIND_TO_CATEGORY.get(att.get("kind"), "other")


def existing_drive_ids(course_map: dict) -> set[str]:
    ids = set()
    for s in course_map.get("stream_items", []):
        for a in s.get("attachments", []):
            if a.get("driveId"):
                ids.add(a["driveId"])
    return ids


def main():
    if len(sys.argv) != 4:
        print("usage: diff_and_plan.py <existing_course_map.json> <fresh_scrape.json> <out_dir>", file=sys.stderr)
        sys.exit(2)
    existing_path, fresh_path, out_dir = sys.argv[1:]
    out_root = Path(out_dir)

    existing = json.loads(Path(existing_path).read_text(encoding="utf-8"))
    fresh = json.loads(Path(fresh_path).read_text(encoding="utf-8"))
    have = existing_drive_ids(existing)

    plan = []
    for item in fresh.get("items", []):
        for att in item.get("attachments", []):
            drive_id = att.get("driveId")
            if not drive_id or drive_id in have:
                continue
            cat = category_for(att, item.get("title", ""))
            if cat == "recordings":
                # User explicitly excluded recordings/videos.
                continue
            dest = out_root / cat / safe_filename(att["title"])
            plan.append({
                "driveId": drive_id,
                "kind": att.get("kind"),
                "title": att.get("title"),
                "category": cat,
                "parent_material": item.get("title"),
                "author": item.get("author"),
                "date": item.get("date"),
                "source_url": att.get("url"),
                "dest_path": str(dest),
            })

    print(json.dumps({"new_items": plan, "skipped_existing": len(have)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
