#!/bin/bash
# Autonomous Self-Reflecting Watchdog for Software Factory Tri-Agent Orchestrator

export PATH="/root/.local/bin:/root/.hermes/tools/node-26.7.0-linux-x64/bin:/root/.hermes/tools/python-3.14.7+202****0901-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

PROJECT_DIR="/root/projects/software-factory"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/watchdog.log"
NOW=$(date -u "+%Y-%m-%d %H:%M:%S UTC")

# 1. Check memory and drop cache if low
FREE_MEM=$(free -m | awk '/^Mem:/{print $7}')
if [ "$FREE_MEM" -lt 350 ]; then
    echo "[$NOW] [WATCHDOG] Low memory ($FREE_MEM MB). Dropping page cache..." >> "$LOG_FILE"
    sync && echo 3 > /proc/sys/vm/drop_caches
fi

# 2. Check if orchestrator is alive; if not, restart it
if ! tmux has-session -t software-factory-orchestrator 2>/dev/null; then
    echo "[$NOW] [WATCHDOG] ⚠️ Orchestrator process NOT FOUND! Reviving in tmux..." >> "$LOG_FILE"
    tmux kill-session -t software-factory-orchestrator 2>/dev/null || true
    tmux new-session -d -s software-factory-orchestrator "cd $PROJECT_DIR && python3 orchestrator.py"
    echo "[$NOW] [WATCHDOG] ✅ Orchestrator revived." >> "$LOG_FILE"
fi

# 2b. Check if webhook server is alive; if not, restart it
if ! pgrep -f "python3 webhook_server.py" > /dev/null; then
    echo "[$NOW] [WATCHDOG] ⚠️ Webhook server NOT FOUND! Reviving in tmux..." >> "$LOG_FILE"
    tmux kill-session -t software-factory-webhook 2>/dev/null || true
    tmux new-session -d -s software-factory-webhook "cd $PROJECT_DIR && python3 webhook_server.py"
    echo "[$NOW] [WATCHDOG] ✅ Webhook server revived." >> "$LOG_FILE"
fi

# 3. SELF-REFLECTION & PROGRESS STALENESS CHECK
LAST_COMMIT_TS=$(git -C "$PROJECT_DIR" log -1 --format=%ct 2>/dev/null || echo 0)
CURRENT_TS=$(date +%s)
COMMIT_AGE=$((CURRENT_TS - LAST_COMMIT_TS))

if [ "$COMMIT_AGE" -gt 1800 ]; then
    echo "[$NOW] [WATCHDOG-SELF-REFLECTION] ⚠️ Progress stalled! Last commit was $((COMMIT_AGE / 60)) minutes ago." >> "$LOG_FILE"

    HUNG_PIDS=$(ps -eo pid,etime,cmd | grep -E "claude -p|codex exec|agy -p" | grep -v grep | while read -r pid etime cmd; do
        if [[ "$etime" =~ [0-9]+:[2-5][0-9]:[0-9]{2} ]] || [[ "$etime" =~ [2-9][0-9]:[0-9]{2} ]]; then
            echo "$pid"
        fi
    done)

    if [ -n "$HUNG_PIDS" ]; then
        echo "[$NOW] [WATCHDOG] Terminating hung agent processes: $HUNG_PIDS" >> "$LOG_FILE"
        kill -9 $HUNG_PIDS 2>/dev/null || true
    fi

    CLAUDE_TEST=$(claude -p "ping" --max-turns 1 2>&1)
    if echo "$CLAUDE_TEST" | grep -qE "503|Unavailable"; then
        echo "[$NOW] [WATCHDOG] Detected Claude gateway 503 limit. Auto-switching to backup model..." >> "$LOG_FILE"
        sed -i 's/"model": .*"/"model": "ag\/gemini-3.8-flash-high"/' /root/.claude/settings.json
    fi
fi

# 4. Check & Process GitHub Issues (Triage, Authorize, Dispatch)
python3 "$PROJECT_DIR/issue_bot.py" >> "$LOG_FILE" 2>&1

# 5. Continuous Deployment: Auto-deploy on new commits
"$PROJECT_DIR/auto_deploy.sh" >> "$LOG_DIR/deploy.log" 2>&1

# 6. Log rotation if > 2MB
if [ -f "$LOG_FILE" ] && [ $(stat -c%s "$LOG_FILE") -gt 2097152 ]; then
    tail -n 1000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi