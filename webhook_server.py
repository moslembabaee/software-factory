#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import roadmap_sync
import roadmap_store
from issue_lifecycle import IGNORED_LABELS, label_names, mark_issue_closed, task_matches_issue

PROJECT_ROOT = Path("/root/projects/software-factory").resolve()
LOG_DIR = PROJECT_ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "webhook.log"
ROADMAP_FILE = PROJECT_ROOT / "ROADMAP.json"


def log(msg: str):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    line = f"[{timestamp}] [WEBHOOK] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def trigger_issue_bot():
    try:
        log("Triggering issue_bot to reconcile roadmap and GitHub issues...")
        subprocess.Popen([sys.executable, str(PROJECT_ROOT / "issue_bot.py")])
    except Exception as e:
        log(f"Error triggering issue_bot: {e}")

def handle_issue_closed(issue_num: int, closed_at: str | None = None):
    if not isinstance(issue_num, int) or issue_num <= 0:
        return
    try:
        if ROADMAP_FILE.exists() and roadmap_store.update_roadmap(
            ROADMAP_FILE, lambda data: mark_issue_closed(data, issue_num, closed_at)
        ):
            roadmap_sync.sync_roadmap_to_github()
            log(f"Synchronized roadmap for closed Issue #{issue_num}")
    except Exception as e:
        log(f"Error synchronizing closed Issue #{issue_num}: {e}")

    try:
        res = subprocess.run(
            ["gh", "issue", "edit", str(issue_num), "--repo", "moslembabaee/software-factory",
             "--remove-label", "in-progress,blocked"],
            capture_output=True, text=True, timeout=30,
        )
        if res.returncode == 0:
            log(f"Removed active labels from closed Issue #{issue_num}")
        else:
            log(f"Label cleanup failed for Issue #{issue_num}: {res.stderr.strip()}")
    except Exception as e:
        log(f"Error removing labels from Issue #{issue_num}: {e}")

def mark_task_approved(issue_num: int):
    def approve(data):
        modified = False
        for task in data.get("tasks", []):
            if (task_matches_issue(task, issue_num) and not task.get("closed_at")
                    and task.get("status") in ("waiting_approval", "pending_approval", "pending", "failed")):
                task["status"] = "approved"
                task["retry_count"] = 0
                modified = True
        return modified

    try:
        if not ROADMAP_FILE.exists() or not roadmap_store.update_roadmap(ROADMAP_FILE, approve):
            return False
        roadmap_sync.sync_roadmap_to_github()
        subprocess.run(
            ["gh", "issue", "edit", str(issue_num), "--repo", "moslembabaee/software-factory",
             "--remove-label", "blocked"], capture_output=True, text=True, timeout=30,
        )
        return True
    except Exception as e:
        log(f"Error in mark_task_approved: {e}")
        return False

class GitHubWebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        event_type = self.headers.get("X-GitHub-Event", "unknown")

        body = self.rfile.read(content_length).decode("utf-8")
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}

        log(f"Received webhook event '{event_type}'")

        if event_type == "ping":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"pong"}')
            return

        if event_type == "issues":
            action = payload.get("action", "")
            issue = payload.get("issue", {})
            num = issue.get("number")
            title = issue.get("title", "")
            label_name = payload.get("label", {}).get("name", "").strip().lower()
            issue_labels = label_names(issue)
            if action == "labeled" and label_name:
                issue_labels.add(label_name)
            elif action == "unlabeled":
                issue_labels.discard(label_name)

            log(f"Issue #{num} ('{title}') action='{action}', label='{label_name}'")

            if action == "closed":
                log(f"Issue #{num} ('{title}') closed event! Removing active labels and synchronizing state...")
                handle_issue_closed(num, issue.get("closed_at"))
            elif issue.get("state") == "closed":
                pass
            elif action == "labeled" and label_name == "approved":
                if any(l in IGNORED_LABELS for l in issue_labels):
                    log(f"Issue #{num} ('{title}') has ignored label ({[l for l in issue_labels if l in IGNORED_LABELS]}). Skipping app queue.")
                else:
                    log(f"Issue #{num} received 'approved' label! Authorizing task...")
                    mark_task_approved(num)
                    trigger_issue_bot()
            elif action in ("opened", "reopened", "labeled", "unlabeled"):
                if any(l in IGNORED_LABELS for l in issue_labels):
                    log(f"Issue #{num} ('{title}') has ignored label. Skipping issue_bot trigger.")
                else:
                    trigger_issue_bot()

        elif event_type == "issue_comment":
            action = payload.get("action", "")
            comment = payload.get("comment", {})
            issue = payload.get("issue", {})
            num = issue.get("number")
            author = comment.get("user", {}).get("login", "").lower()
            comment_body = comment.get("body", "").lower()
            issue_labels = label_names(issue)

            log(f"Comment on Issue #{num} by @{author}: {comment_body[:80]}...")

            if action == "created" and author == "moslembabaee" and issue.get("state") != "closed":
                if any(kw in comment_body for kw in ("/approve", "approved", "lgtm")):
                    if any(l in IGNORED_LABELS for l in issue_labels):
                        log(f"Issue #{num} has ignored label ({[l for l in issue_labels if l in IGNORED_LABELS]}). Skipping app queue despite comment.")
                    else:
                        log(f"Issue #{num} approved via comment by @{author}! Authorizing task...")
                        mark_task_approved(num)
                        trigger_issue_bot()

        elif event_type == "push":
            ref = payload.get("ref", "")
            commits = payload.get("commits", [])
            head_commit = payload.get("after") or (commits[-1].get("id") if commits else "unknown")
            log(f"Push event on ref '{ref}' (head: {head_commit[:8] if head_commit else 'unknown'}, {len(commits)} commits)")
            if ref in ("refs/heads/main", "refs/heads/master"):
                log("Target is production branch main. Triggering auto_deploy.sh in background...")
                try:
                    subprocess.Popen(["/bin/bash", str(PROJECT_ROOT / "auto_deploy.sh")])
                except Exception as e:
                    log(f"Error launching auto_deploy.sh: {e}")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"Software Factory GitHub Webhook Listener is active\n")

    def log_message(self, format, *args):
        pass

def run():
    port = 9097
    server_address = ("127.0.0.1", port)
    httpd = HTTPServer(server_address, GitHubWebhookHandler)
    log(f"🚀 GitHub Webhook Listener running on 127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()
    log("Webhook Listener stopped.")

if __name__ == "__main__":
    run()