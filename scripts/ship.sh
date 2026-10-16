#!/usr/bin/env bash
# Ship EXACTLY what is on the beta site to the live site (lssouthreno.com).
#
#   scripts/ship.sh             # ship what's on beta
#   scripts/ship.sh --dry-run   # do everything except the final push (shows what would change)
#
# Reads the commit the beta site was built from (beta-commit.txt in the beta repo), merges it
# into the latest live main (which keeps getting data commits from the backend), stamps a new
# build (so open dashboards offer "A newer version is ready") and pushes. Retries if the backend
# pushes data at the same moment. Your current checkout is not changed.
set -euo pipefail

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
BETA="LSSouthReno/lssouthreno.github.io"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ -n "${BETA_SHA:-}" ]; then
  SHA="$(git rev-parse "$BETA_SHA")"                       # testing hook: ship a given commit
else
  SHA="$(gh api "repos/$BETA/contents/beta-commit.txt" --jq .content 2>/dev/null | base64 --decode 2>/dev/null | tr -d '[:space:]' || true)"
  [ -n "$SHA" ] || SHA="$(curl -fsSL "https://raw.githubusercontent.com/$BETA/main/beta-commit.txt?cb=$(date +%s)" | tr -d '[:space:]')" \
    || { echo "✋ Could not read beta-commit.txt from $BETA." >&2; exit 1; }
fi
git fetch -q origin
git cat-file -e "$SHA^{commit}" 2>/dev/null || git fetch -q origin staging || true
git cat-file -e "$SHA^{commit}" || { echo "✋ Beta commit $SHA not found locally or on origin/staging." >&2; exit 1; }

echo "→ Shipping beta build $(git rev-parse --short "$SHA") to lssouthreno.com. Changes:"
git log --no-merges --format='   %h %s' "origin/main..$SHA" | grep -v -E ' Update (dashboard|shepherding|funnel)' || echo "   (nothing new — live already has it)"

WT="$(mktemp -d)"
cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; }
trap cleanup EXIT
for try in 1 2 3 4 5 6; do
  git fetch -q origin main
  cleanup; git worktree add -q --detach "$WT" origin/main
  ( cd "$WT" && git merge -q --no-ff --no-edit -m "Ship beta $(git rev-parse --short "$SHA") to live" "$SHA" ) \
    || { echo "✋ Merge conflict between beta and live main — run scripts/stage.sh again (it merges main), re-test, then ship." >&2; exit 1; }
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  python3 - "$WT" "$STAMP" <<'PY'
import sys, re, pathlib
wt, s = pathlib.Path(sys.argv[1]), sys.argv[2]
p = wt / 'index.html'
p.write_text(re.sub(r"var APP_BUILD='[^']*'", "var APP_BUILD='%s'" % s, p.read_text(), count=1))
(wt / 'build.txt').write_text(s + '\n')
PY
  ( cd "$WT" && git add index.html build.txt && git commit -q --amend --no-edit )
  if [ $DRY = 1 ]; then
    echo "→ Dry run — this is what would go live (not pushed):"
    ( cd "$WT" && git diff --stat origin/main HEAD | tail -20 )
    exit 0
  fi
  if ( cd "$WT" && git push -q origin HEAD:main ); then
    echo "✅ Shipped. lssouthreno.com updates in ~1–2 minutes (Pages build)."
    exit 0
  fi
  echo "   live main moved (backend data push) — retrying ($try)…"; sleep 3
done
echo "✋ Could not push after several tries — run it again." >&2; exit 1
