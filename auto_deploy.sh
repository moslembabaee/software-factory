#!/bin/bash
set -u
export PATH="/root/.local/bin:/root/.hermes/tools/node-26.7.0-linux-x64/bin:/root/.hermes/tools/python-3.14.7+202****0901-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

PROJECT_DIR="/root/projects/software-factory"
LOCK_FILE="/tmp/software-factory_deploy.lock"
DEPLOYED_FILE="$PROJECT_DIR/.last_deployed_commit"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy.log"

# Prevent concurrent deploy runs
exec 200>"$LOCK_FILE"
flock -n 200 || { exit 0; }

log() {
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] [AUTO-DEPLOY] $1" >> "$LOG_FILE"
}

cd "$PROJECT_DIR" || exit 1

# 1. Fetch remote changes if any
git fetch origin main >/dev/null 2>&1
REMOTE_COMMIT=$(git rev-parse origin/main 2>/dev/null)
LOCAL_COMMIT=$(git rev-parse HEAD 2>/dev/null)

if [ -n "$REMOTE_COMMIT" ] && [ "$REMOTE_COMMIT" != "$LOCAL_COMMIT" ]; then
    if ! git merge-base --is-ancestor "$REMOTE_COMMIT" HEAD 2>/dev/null; then
        log "New remote commits found on origin/main ($REMOTE_COMMIT). Pulling..."
        git pull --rebase --autostash origin main >> "$LOG_FILE" 2>&1
    fi
fi

CURRENT_COMMIT=$(git rev-parse HEAD 2>/dev/null)
LAST_DEPLOYED=""
if [ -f "$DEPLOYED_FILE" ]; then
    LAST_DEPLOYED=$(cat "$DEPLOYED_FILE" 2>/dev/null)
fi

if [ -z "$CURRENT_COMMIT" ]; then
    exit 0
fi

# 2. Check if deployed version matches current commit
if [ "$CURRENT_COMMIT" != "$LAST_DEPLOYED" ]; then
    log "Update detected! Current: $CURRENT_COMMIT, Deployed: ${LAST_DEPLOYED:-none}."

    # Install dependencies and typecheck
    log "Running npm ci..."
    if ! npm ci >> "$LOG_FILE" 2>&1; then
        log "❌ npm ci failed"
        exit 1
    fi

    log "Running npm run build (typecheck)..."
    if ! npm run build >> "$LOG_FILE" 2>&1; then
        log "❌ Build (typecheck) failed, not deploying"
        exit 1
    fi

    # Check if docker-compose.yml has a web/app service defined before attempting docker deploy
    if docker compose -f "$PROJECT_DIR/docker-compose.yml" config --services 2>/dev/null | grep -qv "^postgres$"; then
        log "App service detected in docker-compose.yml. Building and deploying Docker..."
        if docker compose -f "$PROJECT_DIR/docker-compose.yml" build >> "$LOG_FILE" 2>&1; then
            log "Docker build succeeded. Starting services and waiting for health checks..."
            if docker compose -f "$PROJECT_DIR/docker-compose.yml" up -d --wait --wait-timeout 120 --remove-orphans >> "$LOG_FILE" 2>&1; then
                echo "$CURRENT_COMMIT" > "$DEPLOYED_FILE"
                log "✅ Deployment successful for commit: $CURRENT_COMMIT"
            else
                log "❌ Error restarting Docker container"
            fi
        else
            log "❌ Docker build failed for commit $CURRENT_COMMIT"
        fi
    else
        log "No app service in docker-compose.yml (only postgres). Skipping Docker deploy, marking commit as deployed."
        echo "$CURRENT_COMMIT" > "$DEPLOYED_FILE"
    fi
fi