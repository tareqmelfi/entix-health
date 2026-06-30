#!/bin/bash
# Entix Health Vita - one-shot deploy push (safe, no inline comments to break zsh)
set -e
cd "/Users/tareqalrowaili/Downloads/ENSIDEX OS/06_Projects/ENTX-Vita - Entix.Health Personal Vita app/05-API-Code"
rm -f .git/index.lock
git add -A
git commit -m "protocol v2 timeline adherence + reports page + range indicators + splash + reset endpoint" || echo "(nothing new to commit)"
git push origin main
echo ""
echo "============================================"
echo " DONE - code pushed to GitHub."
echo " Now tell Claude:  تم"
echo "============================================"
