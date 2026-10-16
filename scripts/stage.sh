#!/usr/bin/env bash
# Put the current branch on the BETA site (https://lssouthreno.github.io/) for testing.
# The live site (lssouthreno.com) is not touched.
#
#   scripts/stage.sh            # from the branch you are testing (normally `staging`)
#   scripts/stage.sh --local    # same build, but served on this Mac at http://localhost:8790
#                               # (no GitHub needed; nothing is published)
#
# What it does:
#   1. merges the latest live code + data (origin/main) into this branch, so beta = what would ship
#   2. backs the branch up to GitHub as `staging`
#   3. builds a beta copy (no CNAME, beta ribbon, reads live data from lssouthreno.com)
#   4. publishes it to the LSSouthReno/lssouthreno.github.io repo (GitHub Pages, ~1 min)
# Ship what you tested with scripts/ship.sh.
set -euo pipefail
LOCAL=0; SERVE=1
case "${1:-}" in --local) LOCAL=1;; --build-only) LOCAL=1; SERVE=0;; esac

BETA_REPO="https://github.com/LSSouthReno/lssouthreno.github.io.git"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✋ Uncommitted changes — commit them first (beta publishes commits only)." >&2; exit 1
fi

echo "→ Bringing in the latest live code + data (origin/main)…"
git fetch -q origin
if ! git merge -q --no-edit origin/main; then
  echo "✋ Merge with live main has conflicts — resolve them, commit, and run again." >&2; exit 1
fi
SHA="$(git rev-parse HEAD)"; SHORT="$(git rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [ $LOCAL = 1 ]; then
  BUILD="$ROOT/.beta-build"; rm -rf "$BUILD"; mkdir -p "$BUILD"
else
  echo "→ Backing up this branch to origin/staging…"
  git push -q origin "HEAD:refs/heads/staging" --force-with-lease=staging 2>/dev/null || git push -q origin "HEAD:refs/heads/staging"
  BUILD="$(mktemp -d)"; trap 'rm -rf "$BUILD"' EXIT
fi
git archive "$SHA" | tar -x -C "$BUILD"
cd "$BUILD"
# Never let beta claim the real domain, and leave out backend source / tooling.
rm -rf CNAME .github .claude .clasp.json appsscript.json Code_*.gs Code_*.js Deprecated node_modules
# Data files the backend keeps fresh on the live site → beta reads them from there.
DATA_FILES="$(cd "$ROOT" && git ls-tree --name-only origin/main | grep -E '\.json$' | grep -v manifest | python3 -c 'import sys,json;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')"
INFO="{\"commit\":\"$SHORT\",\"built\":\"$STAMP\",\"live\":\"https://lssouthreno.com\"}"
python3 - "$ROOT/scripts/beta-inject.html" "$DATA_FILES" "$INFO" "$STAMP" <<'PY'
import sys, pathlib, re
inject = pathlib.Path(sys.argv[1]).read_text().replace('/*DATA_FILES*/[]', sys.argv[2]).replace('/*BETA_INFO*/{}', sys.argv[3])
stamp = sys.argv[4]
for p in pathlib.Path('.').rglob('*.html'):
    t = p.read_text()
    if '<head>' not in t: continue
    t = t.replace('<head>', '<head>\n' + inject, 1)
    t = re.sub(r"var APP_BUILD='[^']*'", "var APP_BUILD='%s'" % stamp, t)
    p.write_text(t)
pathlib.Path('build.txt').write_text(stamp + '\n')
PY
touch .nojekyll
printf '%s\n' "$SHA" > beta-commit.txt
printf 'User-agent: *\nDisallow: /\n' > robots.txt

if [ $LOCAL = 1 ]; then
  [ $SERVE = 0 ] && { echo "✅ Local beta built ($SHORT) in .beta-build/"; exit 0; }
  echo "✅ Local beta built ($SHORT) → http://localhost:8790/   (Ctrl-C to stop)"
  exec node "$ROOT/scripts/beta-serve.mjs" "$BUILD" 8790
fi

echo "→ Publishing beta ($SHORT)…"
git init -q -b main
git add -A
git -c user.name="LSSR beta" -c user.email="beta@lssouthreno.com" commit -q -m "Beta $SHORT ($STAMP)"
git push -q --force "$BETA_REPO" main

echo "✅ Beta updated → https://lssouthreno.github.io/  (commit $SHORT; live in ~1 minute)"
echo "   When it's right: scripts/ship.sh"
