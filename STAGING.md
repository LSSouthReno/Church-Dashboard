# Beta (test) site → live

| | Address | Built from |
|---|---|---|
| **Live** | https://lssouthreno.com | `main` (the backend also pushes data here every hour) |
| **Beta** | https://lssouthreno.github.io | the `staging` branch, published to the `LSSouthReno/lssouthreno.github.io` repo |

The beta site shows today's real numbers: it reads the data files from lssouthreno.com.
It has a purple **BETA** ribbon and is hidden from search engines.
Sign-ins are separate from live, so sign in again on beta.

**Edits made on beta still save to the real data** (Staff OS tasks, Care edits, notes and so on), because both sites use the same Apps Script backend.
Test reading freely, and test writing carefully.
Backend (Apps Script) changes do not go through beta; deploy them separately.

## Commands (run from a checkout of the `staging` branch)

```bash
scripts/setup-beta.sh        # ONE TIME: creates the beta repo + first publish
scripts/stage.sh             # put the current branch on beta (merges live main first)
scripts/stage.sh --force     # replace beta even if origin/staging has commits this branch lacks
scripts/stage.sh --local     # same build, on this Mac only: http://localhost:8790
scripts/ship.sh --dry-run    # show exactly what would go live
scripts/ship.sh              # ship EXACTLY what's on beta to lssouthreno.com
```

`ship.sh` ships the commit the beta site was built from (`beta-commit.txt`), not whatever happens to be checked out.
It merges that commit into the latest live `main`, stamps a new build (open dashboards then offer "A newer version is ready"), and pushes.
It retries if the backend pushes data at the same moment.

To undo a ship, revert the "Ship beta … to live" merge commit on `main` (`git revert -m 1 <sha>`) and push.
