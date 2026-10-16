import os
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path("/root/projects/software-factory").resolve()
ROADMAP_JSON = PROJECT_ROOT / "ROADMAP.json"
ROADMAP_MD = PROJECT_ROOT / "ROADMAP.md"
REPO = "moslembabaee/software-factory"

def generate_roadmap_markdown(roadmap_data: dict) -> str:
    tasks = roadmap_data.get("tasks", [])
    total = len(tasks)
    completed = [t for t in tasks if t.get("status") == "completed"]
    in_progress = [t for t in tasks if t.get("status") in
                   ("in_progress", "ready_for_verification", "verified")]
    pending = [t for t in tasks if t.get("status") in
               ("pending", "failed", "approved", "waiting_approval", "pending_approval", "assigned", "escalated")]

    pct = int((len(completed) / total * 100)) if total > 0 else 0
    filled_bars = int(pct / 5)
    bar = "█" * filled_bars + "░" * (20 - filled_bars)

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    md = []
    md.append("# 🗺️ Live Development Roadmap & Task Tracker")
    md.append("")
    md.append(f"> **Last Updated:** `{now_str}`  ")
    md.append("> **Supervisor:** Autonomous Tri-Agent Orchestra (`Claude Code` ↔ `OpenAI Codex` ↔ `Google Antigravity`)  ")
    md.append(f"> **Progress:** `[{bar}]` **{len(completed)} / {total}** tasks completed (**{pct}%**)")
    md.append("")
    md.append("---")
    md.append("")

    # 1. In Progress
    md.append("## ⚡️ Currently In Progress")
    md.append("")
    if in_progress:
        for t in in_progress:
            t_id = t.get("id", "")
            t_title = t.get("title", "")
            t_phase = t.get("phase", "General")
            t_agent = str(t.get("assigned_agent", "auto")).upper()
            t_desc = t.get("description", "")
            t_cmd = t.get("verification_cmd", "npm run build")

            md.append(f"### 🟡 `{t_id}` — {t_title}")
            md.append(f"- **Phase:** {t_phase}")
            md.append(f"- **Status:** `{t['status']}`")
            md.append(f"- **Assigned Agent:** `{t_agent}`")
            md.append(f"- **Description:** {t_desc}")
            md.append(f"- **Quality Gate Command:** `{t_cmd}`")
            md.append("")
    else:
        md.append("_No task currently executing. Waiting for approved roadmap tasks._")
        md.append("")

    md.append("---")
    md.append("")

    # 2. Upcoming Queue
    md.append("## 📋 Upcoming Queue (Next in Priority)")
    md.append("")
    if pending:
        md.append("| Priority | Task ID | Title | Assigned Agent | Phase |")
        md.append("|:---:|:---|:---|:---:|:---|")
        for idx, t in enumerate(pending, 1):
            t_id = t.get("id", "")
            t_title = t.get("title", "")
            t_phase = t.get("phase", "")
            t_agent = str(t.get("assigned_agent", "auto")).upper()
            md.append(f"| **#{idx}** | `{t_id}` | {t_title} | `{t_agent}` | {t_phase} |")
        md.append("")
    else:
        md.append("_No queued tasks. New proposals require approval before dispatch._")
        md.append("")

    md.append("---")
    md.append("")

    # 3. Completed Deliverables
    md.append("## 🟢 Completed Deliverables")
    md.append("")
    if completed:
        md.append("| Status | Task ID | Title | Agent | Phase | Completed At |")
        md.append("|:---:|:---|:---|:---:|:---|:---|")
        for t in reversed(completed):
            t_id = t.get("id", "")
            t_title = t.get("title", "")
            t_phase = t.get("phase", "")
            t_agent = str(t.get("assigned_agent", "auto")).upper()
            comp_time = t.get("completed_at", "Completed")
            if "T" in comp_time:
                comp_time = comp_time.split("T")[0] + " " + comp_time.split("T")[1][:8]
            md.append(f"| 🟢 Done | `{t_id}` | {t_title} | `{t_agent}` | {t_phase} | `{comp_time}` |")
        md.append("")

    return "\n".join(md)

def sync_roadmap_to_github():
    if not ROADMAP_JSON.exists():
        return

    with open(ROADMAP_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    md_content = generate_roadmap_markdown(data)

    # Write local ROADMAP.md
    with open(ROADMAP_MD, "w", encoding="utf-8") as f:
        f.write(md_content)

if __name__ == "__main__":
    sync_roadmap_to_github()
    print("ROADMAP.md updated successfully!")
