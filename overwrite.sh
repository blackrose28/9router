#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
GLOBAL_APP="$(npm root -g)/9router/app"

if [ ! -d "$GLOBAL_APP" ]; then
  echo "❌ Global 9router not found at $GLOBAL_APP"
  exit 1
fi

echo "Source : $SRC_DIR"
echo "Target : $GLOBAL_APP"

# Build
cd "$SRC_DIR"
npm run build

# Stop running 9router
pkill -f "9router/app/server.js" 2>/dev/null || true
sleep 1

# Backup
BACKUP="$GLOBAL_APP/.next.bak.$(date +%s)"
[ -d "$GLOBAL_APP/.next" ] && mv "$GLOBAL_APP/.next" "$BACKUP"

# Copy build + source
cp -r "$SRC_DIR/.next" "$GLOBAL_APP/.next"
rsync -a --delete --exclude='node_modules' --exclude='.next' --exclude='.git' --exclude='.env*' \
  "$SRC_DIR/src/" "$GLOBAL_APP/src/"
[ -f "$SRC_DIR/.next/standalone/server.js" ] && cp "$SRC_DIR/.next/standalone/server.js" "$GLOBAL_APP/server.js"
[ -d "$SRC_DIR/public" ] && rsync -a "$SRC_DIR/public/" "$GLOBAL_APP/public/"

# Cleanup old backups (keep 3)
ls -dt "$GLOBAL_APP/.next.bak."* 2>/dev/null | tail -n +4 | xargs rm -rf 2>/dev/null || true

echo "✅ Done! Run: 9router"
