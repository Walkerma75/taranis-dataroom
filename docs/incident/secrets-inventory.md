# Secrets Inventory — Pre-scrub

**Date:** 21 April 2026
**Purpose:** Complete enumeration of every secret committed to the `Walkerma75/taranis-dataroom` git history, prior to running `git filter-repo`. Written for Mark's sign-off before the scrub.
**Repo:** `Walkerma75/taranis-dataroom` (private), local clone at `Claude Cowork/Taranis Dataroom/taranis-dataroom/`
**Scope:** all commits on all refs, plus any present-but-uncommitted working-tree state that would be captured if `git add -A` were run.

---

## Summary

Four distinct secrets are present in history. All four were committed on **8 April 2026**, in the first three push-to-origin commits. No secret was added or removed by any subsequent commit. Every secret below appears in at least one file in `HEAD` on `main` — i.e. the repo today still exposes them.

| # | Secret | Type | Commits | Files in HEAD | Production status |
|---|---|---|---|---|---|
| 1 | AWS Access Key ID, tail `OP7D` | AWS IAM access key (`AKIA…`) | `2cf91ce` | `DEPLOY_NOW.md` | **Deactivated** by Mark on a prior date (pre-21 Apr 2026) — CloudTrail pull pending |
| 2 | AWS Secret Access Key paired with #1 | AWS IAM secret key (40 chars) | `2cf91ce` | `DEPLOY_NOW.md` | Deactivated with #1 |
| 3 | RDS master password (`taranis` DB user) | PostgreSQL password | `2cf91ce` | `DEPLOY_NOW.md` | **Still live** — to be rotated by Mark per TASKS.md |
| 4 | `<default-admin-password>` — seed + default app admin password | Application login password | `bac700e`, `2cf91ce`, `91f3d21` | 5 files (see §4) | **Rotated** in the live app by Mark on 2026-04-21. The string remains in git history and must still be scrubbed. |

No other secrets were found — no additional AWS keys, no private keys (RSA/OPENSSH/EC/DSA), no Google API keys (`AIza…`), no `postgresql://` connection strings with embedded credentials, no SMTP / SES / Twilio / SNS credentials, no generic bearer/`client_secret`/`api_key` strings, no `.env*` file ever tracked.

Two additional **dev-only placeholder strings** exist in committed code but are not real secrets; see §6.

---

## How the inventory was produced

All searches were run against the full reflog (`--all`) of the local clone, which is up-to-date with `origin/main` except for one local commit ahead (`91f3d21`, already on the local branch).

```
# 1. AKIA-pattern AWS access key IDs
git log --all -p --diff-filter=A | grep -oE "AKIA[A-Z0-9]{16}"

# 2. ASIA-pattern AWS session tokens
git log --all -p | grep -oE "ASIA[A-Z0-9]{16}"

# 3. AWS secret access key (by unique fragment of the known value)
git log --all --oneline -S "<secret-key-prefix>"

# 4. RDS master password (by unique fragment)
git log --all --oneline -S "<rds-pwd-prefix>"

# 5. <default-admin-password> (app admin password)
git log --all --oneline -S "<default-admin-password>"

# 6. Private-key PEM blocks
git log --all -p | grep -E "BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY"

# 7. Embedded-credential DB connection strings
git log --all -p | grep -oE "postgresql://[^\"' )]+"

# 8. Google API keys
git log --all -p | grep -oE "AIza[0-9A-Za-z_-]{35}"

# 9. SMTP / SES / SNS / Twilio credentials (case-insensitive)
git log --all -p | grep -iE "(smtp_pass|ses_access_key|ses_smtp|twilio|sns_)"

# 10. Generic bearer tokens / client_secret / api_key
git log --all -p | grep -iE "( bearer [A-Za-z0-9]{20,}|client_secret['\"]?\s*[:=]\s*['\"][^'\"]{10,}|api[_-]?key['\"]?\s*[:=]\s*['\"][^'\"]{10,})"

# 11. .env-like or cert files ever added to history
git log --all --pretty=format: --name-only --diff-filter=A | sort -u | grep -iE '\.env|secrets|credentials|private[-_]?key'

# 12. Working-tree sweep (modified + untracked, excluding node_modules/.git)
grep -rEn "AKIA[A-Z0-9]{16}|<default-admin-password>|<rds-pwd-prefix>|<secret-key-prefix>|..." . (full pattern list above)
```

Results: only patterns 1, 3, 4, 5 returned hits — all expected and enumerated below. Patterns 2, 6, 7, 8, 9, 10, 11 returned zero hits.

---

## 1. AWS Access Key ID (`AKIA…OP7D`)

- **Kind:** AWS IAM access key (long-lived, not session credential)
- **Associated IAM user:** `taranis-deploy` per project notes (to be retired; replacement will be `taranis-dataroom-deploy`)
- **Committed in:** `2cf91ce Initial commit - Taranis Data Room` (2026-04-08 11:18 +0400)
- **Files in HEAD containing the value:** `DEPLOY_NOW.md` only (lines 43, 89)
- **Find command:** `git log --all --oneline -S "AKIA...OP7D"`
- **Production status:** **Deactivated** by Mark during earlier work on the Taranis Capital static-website project. Confirmed by Mark 21 Apr 2026. The key cannot sign new AWS API calls.
- **Replacement plan:** new IAM user `taranis-dataroom-deploy` with a least-privilege policy scoped to this project's ECR repos, ECS cluster/service, and S3 document bucket only. Mark creates in TASKS.md step 3.
- **CloudTrail review:** pending — see `docs/incident/README.md` after the pull completes.
- **Scrub action:** remove via `git filter-repo` as part of removing `DEPLOY_NOW.md` entirely.

## 2. AWS Secret Access Key (paired with #1)

- **Kind:** 40-character AWS IAM secret key
- **Committed in:** `2cf91ce Initial commit - Taranis Data Room`
- **Files in HEAD containing the value:** `DEPLOY_NOW.md` only (lines 44, 90)
- **Find command:** `git log --all --oneline -S "<secret-key-prefix>"` (unique fragment)
- **Production status:** deactivated with the access key ID above. Worthless on its own.
- **Replacement plan:** a new secret is generated automatically when AWS creates the replacement access key for `taranis-dataroom-deploy`.
- **Scrub action:** removed with `DEPLOY_NOW.md`.

## 3. RDS master password (database user `taranis`)

- **Kind:** PostgreSQL password for the RDS master user
- **Committed in:** `2cf91ce Initial commit - Taranis Data Room`
- **Files in HEAD containing the value:** `DEPLOY_NOW.md` only (line 102)
- **Find command:** `git log --all --oneline -S "<rds-pwd-prefix>"` (unique fragment)
- **Production status:** **still live** — this is the password the running ECS task is using to connect to RDS right now, via the `POSTGRES_PASSWORD` environment variable in the task definition (plaintext env var, not a Secrets Manager reference — see known risk in the inventory).
- **Replacement plan:** TASKS.md steps 4–6 for Mark:
  1. Create Secrets Manager secret `taranis-dataroom/rds/master` (or similar) with a fresh random password.
  2. Register a new ECS task-definition revision that reads `POSTGRES_PASSWORD` from the secret via the `secrets:` block.
  3. Rotate the RDS master password to match the new value in Secrets Manager.
  4. Force-new-deployment so the running tasks pick up the new task def.

  The ordering matters: secret must exist and task def must reference it before RDS is rotated, or the live task will fail to connect.
- **Scrub action:** removed with `DEPLOY_NOW.md`.

## 4. Admin application password (`<default-admin-password>`)

- **Kind:** default password for the seeded app admin `admin@taraniscapital.com`
- **Committed in:**
  - `bac700e Initial commit: Taranis Capital Data Room` (2026-04-08 09:51 +0400) — first appearance
  - `2cf91ce Initial commit - Taranis Data Room` (2026-04-08 11:18 +0400)
  - `91f3d21 Add auto-migrate and seed on API startup` (2026-04-08 13:56 +0400)
- **Find command:** `git log --all --oneline -S "<default-admin-password>"`
- **Files in HEAD containing the value (5 files):**

  | File | Line | Form | First commit |
  |---|---|---|---|
  | `packages/api/src/db/seed.js` | 5 | comment | `bac700e` |
  | `packages/api/src/db/seed.js` | 20 | argon2 hash input | `bac700e` |
  | `packages/api/src/index.js` | 163 | argon2 hash input (auto-seed on startup) | `91f3d21` |
  | `deploy.bat` | 84 | console echo at end of script | `2cf91ce` |
  | `DEPLOY_NOW.md` | 76 | deploy cheatsheet | `2cf91ce` |
  | `AWS_Deployment_Summary.md` | 209 | deployment summary | `bac700e` |

- **Production status:** **rotated** — Mark changed the admin password in the live app on 2026-04-21 (confirmed in chat). `<default-admin-password>` is no longer a working production credential. The string nonetheless remains in git history and must be scrubbed to prevent any future "default" assumption and to close the exposure artefact. Do not attempt a login to verify.
- **Replacement plan for the *default* (not this one rotation):** the rewrite at scrub step (e) removes every hard-coded `<default-admin-password>`. `seed.js` and `autoSeed()` will require a `SEED_ADMIN_PASSWORD` env var, and fail if it is absent in production. No fallback default — absence should be loud. Docs will describe setting the value in Secrets Manager or as an env var at seed time, and rotating through the app UI thereafter.
- **Behavioural note — important:** the standalone `seed.js` uses `INSERT ... ON CONFLICT (email) DO UPDATE SET password_hash = $1` — i.e. every time `npm run seed` is run, it resets the admin password back to the coded value. The `autoSeed()` in `index.js` is safer because it does a `SELECT` up-front and returns early if an admin already exists — so container restarts alone do **not** overwrite the current live admin password. Both forms will be rewritten at step (e) to (a) only insert, never update, and (b) take the seed password from an env var.
- **Scrub action:**
  - `DEPLOY_NOW.md` — removed entirely
  - `deploy.bat` — echo line removed
  - `AWS_Deployment_Summary.md` — line 209 redacted to generic guidance
  - `packages/api/src/db/seed.js` — rewrite (admin-only, env-var password)
  - `packages/api/src/index.js` — `autoSeed()` rewrite (admin-only, env-var password)
  - `git filter-repo` replacement string will catch any residual `<default-admin-password>` across all history in all files.

## 5. Uncommitted working-tree copies

`MIGRATION-BRIEF.md` is present in the repo root but untracked. It contains `<default-admin-password>` in three locations as part of the discovery instructions (lines 99, 143, 145, 226, 310). Because it is untracked, it has never been committed or pushed. Recommendation: do not commit it; the scrub branch should not `git add` it; the end-of-session commit will explicitly stage only the two new discovery files (`CLAUDE.md`, `MIGRATION-INVENTORY.md`). The brief itself lives at its canonical location in the Cowork folder, outside the repo.

The 8 April in-progress uncommitted work (14 modified files, untracked `BulkUploadModal.jsx` / `PdfViewer.jsx` / `deploy-api.bat` / `setup-s3.bat` / `bulk-import.bat` / `scripts/`) was swept with the full pattern list. No new secrets found beyond the known `<default-admin-password>` hits in `AWS_Deployment_Summary.md`, `deploy.bat`, `packages/api/src/db/seed.js`, `packages/api/src/index.js` already listed. The 8 April `deploy-api.bat` and `setup-s3.bat` contain only AWS account ID, region, bucket name, and IAM policy JSON — no credentials. `bulk-import.bat` is empty.

## 6. Dev-only placeholder strings (NOT scrub targets)

Two strings in committed code look secret-shaped but are public, obvious placeholders for local development. They are not rotated and are not removed by the scrub. They are flagged here so the scrub's replacement patterns don't accidentally hit them.

| Value | Location | Why it's not a secret |
|---|---|---|
| `changeme_local_only` | `docker-compose.yml` | Dev-only default Postgres password used if `POSTGRES_PASSWORD` env var is unset when running `docker compose up` locally. Never used in production (ECS passes its own value). |
| `local-dev-secret-do-not-use-in-production` | `packages/api/src/services/auth.js:9` | Dev-only fallback for `JWT_SECRET`. The name warns against production use. |

**Hardening follow-up (logged to TASKS.md, not inline):** the JWT fallback is defensible locally but dangerous if `JWT_SECRET` is ever absent in production — the app would silently issue forgeable tokens. Follow-up: make the API fail-fast when `NODE_ENV === 'production'` and `JWT_SECRET` is unset or equals the dev string. Same pattern should apply to `POSTGRES_PASSWORD` and the forthcoming `SEED_ADMIN_PASSWORD`.

---

## Scrub plan — the filter-repo invocation

After your sign-off on this inventory **and** the CloudTrail findings, the scrub at step (g) will:

1. **Delete path:** `DEPLOY_NOW.md` — removed from every commit on every ref.
2. **Literal-string replacement** (value → placeholder), applied across all paths, all commits:
   - `AKIA...OP7D` → `REDACTED-AWS-ACCESS-KEY`
   - the full secret-access-key value → `REDACTED-AWS-SECRET-KEY`
   - the full RDS master-password value → `REDACTED-RDS-PASSWORD`
   - `<default-admin-password>` → `REDACTED-SEED-PASSWORD`
3. **Verify** afterwards by re-running every search in §"How the inventory was produced". Expected result: zero hits.

The literal-replacement list will be fed to `git filter-repo --replace-text` via a secrets-replacements file (uncommitted, shredded after the scrub — or kept in a gitignored path outside the repo).

## What this inventory does NOT cover

- Secrets that might exist elsewhere on Mark's laptop (e.g. `%USERPROFILE%\.aws\credentials`, `.env` files outside the repo, clipboard, terminal history). Those are out of scope for a git-history scrub.
- Secrets in **forks or clones** of the repo held by anyone else. Step (d) explicitly asks Mark to confirm no other clones exist.
- Secrets that may have been exfiltrated from git before deactivation. The CloudTrail review at step (b) is the defence against this.
- Runtime secrets inside the running Fargate task's environment (they are in the task definition's plaintext `environment:` block today, not in Secrets Manager — that's the TASKS.md remediation).

---

## Sign-off

Pending Mark's written confirmation that:

- [ ] The four secrets above are the complete set — no known additional secret has been committed that this inventory misses.
- [ ] The scrub may proceed on the four values and the file deletion as listed in §"Scrub plan".
- [ ] The dev placeholders in §6 must be preserved by the scrub.
