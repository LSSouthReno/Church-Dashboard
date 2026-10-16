#!/usr/bin/env bash
# Ship EXACTLY what is on the beta site to the live site (lssouthreno.com).
#
#   scripts/ship.sh
#
# Reads the commit the beta site was built from (beta-commit.txt), merges it into the latest
# live main (which keeps getting data commits from the backend) and pushes. Retries if the
# backend pushes data at the same moment. Nothing on your current checkout changes.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
SHA="$(curl -fsSL "https://raw.githubusercontent.com/LSSouthReno/lssouthreno.github.io/main/beta-commit.txt?cb=$(date +%s)" | tr -d '[:space:]')" \
  || { echo "✋ Could not read beta-commit.txt from the beta repo." >&2; exit 1; }
# raw.githubusercontent is CDN-cached; prefer the API copy if gh is available.
if command -v gh >/dev/null 2>&1; then
  API_SHA="$(gh api repos/LSSouthReno/lssouthreno.github.io/contents/beta-commit.txt --jq .content 2>/dev/null | base64 --decode 2>/dev/null | tr -d '[:space:]' || true)"
  [ -n "$API_SHA" ] && SHA="$API_SHA"
fi
git fetch -q origin
git cat-file -e "$SHA^{commit}" 2>/dev/null || git fetch -q origin staging
git cat-file -e "$SHA^{commit}" || { echo "✋ Beta commit $SHA not found locally or on origin/staging." >&2; exit 1; }
echo "→ Shipping beta build $(git rev-parse --short "$SHA") to lssouthreno.com"
git log --oneline "origin/main..$SHA" | grep -v -E 'Update (dashboard|shepherding|funnel)|^.{9}Merge ' | sed 's/^/   /' || true

WT="$(mktemp -d)"; trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"' EXIT
for try in 1 2 3 4 5 6; do
  git fetch -q origin main
  rm -rf "$WT"; git worktree add -q --detach "$WT" origin/main
  ( cd "$WT"
    git merge -q --no-ff --no-edit -m "Ship beta $(git rev-parse --short "$SHA") to live" "$SHA" ) \
    || { echo "✋ Merge conflict between beta and live main — run scripts/stage.sh again (it merges main), re-test, then ship." >&2; exit 1; }
  if ( cd "$WT" && git push -q origin HEAD:main ); then
    echo "✅ Shipped. lssouthreno.com updates in ~1–2 minutes (Pages build)."
    exit 0
  fi
  echo "   main moved (backend data push) — retrying ($try)…"; git worktree remove --force "$WT"; sleep 3
done
echo "✋ Could not push after several tries — run again." >&2; exit 1
