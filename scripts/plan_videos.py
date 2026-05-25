"""Read a fresh classroom scrape and emit a download plan for every recording.

Input:
    python3 scripts/plan_videos.py <fresh_scrape.json> <out_plan.json>

Output (JSON):
    {
      "videos": [
        {"drive_id": "...", "title": "...", "parent": "...", "kind": "drive_file"},
        ...
      ],
      "skipped": [
        {"reason": "...", "title": "...", "parent": "..."}
      ]
    }

Categorization reuses category_for() from diff_and_plan.py. Only Drive *files*
(kind=="drive_file") matching recording keywords are added to the plan — Drive
folders and external links (e.g. YouTube) are listed in `skipped` for manual
follow-up since the existing downloader handles single Drive video IDs only.
"""

import json
import sys
from pathlib import Path

# Reuse the keyword/category logic that already classifies recordings.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from diff_and_plan import category_for  # noqa: E402


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: plan_videos.py <fresh_scrape.json> <out_plan.json>", file=sys.stderr)
        sys.exit(2)

    scrape = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    plan: list[dict] = []
    skipped: list[dict] = []
    seen_ids: set[str] = set()

    for item in scrape.get("items", []):
        parent = item.get("title", "")
        for att in item.get("attachments", []):
            if category_for(att, parent) != "recordings":
                continue

            drive_id = att.get("driveId")
            kind = att.get("kind")
            title = att.get("title") or "(untitled)"
            entry = {"drive_id": drive_id, "title": title, "parent": parent, "kind": kind}

            if not drive_id:
                skipped.append({**entry, "reason": "no driveId (likely external link)"})
                continue
            if kind != "drive_file":
                skipped.append({**entry, "reason": f"kind={kind} not supported by downloader"})
                continue
            if drive_id in seen_ids:
                continue
            seen_ids.add(drive_id)
            plan.append(entry)

    Path(sys.argv[2]).write_text(
        json.dumps({"videos": plan, "skipped": skipped}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"plan: {len(plan)} videos to download, {len(skipped)} skipped -> {sys.argv[2]}", file=sys.stderr)


if __name__ == "__main__":
    main()
