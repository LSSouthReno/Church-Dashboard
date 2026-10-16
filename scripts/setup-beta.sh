#!/usr/bin/env bash
# ONE-TIME: create the beta site https://lssouthreno.github.io/ (a public GitHub Pages repo
# separate from the live Church-Dashboard repo), then publish the current branch to it.
set -euo pipefail
REPO="LSSouthReno/lssouthreno.github.io"
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo create "$REPO" --public \
    --description "BETA test copy of the Church Dashboard (live: lssouthreno.com). Published by scripts/stage.sh in Church-Dashboard; do not edit here."
fi
"$(dirname "$0")/stage.sh"
# Pages normally turns itself on for <user>.github.io repos; make sure it serves main /.
gh api -X POST "repos/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 || true
gh api "repos/$REPO/pages" --jq '"Pages: " + .status + " → " + .html_url' 2>/dev/null || true
