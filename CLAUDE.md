# Claude Context — Taranis Dataroom

**Purpose:** invite-only document portal for Taranis Capital fund investors, advisors and consultants (PPMs, LPAs, subscription agreements, technical annexes, notices).
**Owner entity:** Taranis Capital — **not** Pro-curo. The spec's references to "Pro-curo V5 stack alignment" are historical noise; disregard.
**State:** LIVE (beta) at `https://dataroom.taraniscapital.com` since 8 April 2026.
**Regulator:** DFSA.

## Tech stack

- **Backend:** Node.js 20 + Express + Prisma-less raw SQL, Argon2id, JWT + TOTP MFA, SMS MFA fallback.
- **Frontend:** React + Vite + Ant Design 5 + `@react-pdf-viewer/*`.
- **Monorepo:** npm workspaces — `packages/api`, `packages/web`.
- **DB:** PostgreSQL 16 on RDS (single-AZ db.t3.micro, eu-west-2b today). Append-only `audit_log` with UPDATE/DELETE blocked at trigger level. 8-year retention is DFSA-aligned — never prune, never drop, never alter those triggers.
- **Containers:** Docker Compose locally; ECS Fargate in prod (cluster `taranis-dataroom`, service `taranis-dataroom-service`, task-definition family `taranis-dataroom`).
- **Storage:** documents in S3 bucket `taranis-dataroom-documents-prod` (bytes byte-for-byte; metadata in Postgres).

## AWS layout — names only, no secret values

- **Account:** `TaranisCapital` (`571600836975`) — **same account** as the live static `taraniscapital.com` website and five fund-subdomain buckets (biotech, datacentre, property, fintech, disruptive-tech). Stay scoped to Dataroom resources. No Route 53 changes, no CloudFront changes, no website-bucket changes.
- **Region:** `eu-west-2` (ALB cert lives here; any future CloudFront cert would live in `us-east-1`).
- **VPC:** `vpc-0b04921984aea3eed` / `10.0.0.0/16`, two public + two private subnets across `eu-west-2a`/`eu-west-2b`, NAT gateway, S3 gateway VPC endpoint.
- **ALB:** `taranis-dataroom-alb` — HTTP 80 redirects to HTTPS 443. Target group `taranis-dataroom-tg`. ACM cert `arn:aws:acm:eu-west-2:571600836975:certificate/e8bb602c-…` (`dataroom.taraniscapital.com`, expires 23 October 2026, DNS-validated, auto-renew).
- **ECR:** `taranis-dataroom/api` + `taranis-dataroom/web`. Scan-on-push **on**. Tag mutability MUTABLE.
- **RDS:** `taranis-dataroom`, PostgreSQL 16.10, 20 GB gp3, private subnet, RDS SG (`sg-0fbe0581232c887da`) only allows 5432 from the ECS SG (`sg-096263a85fd487bec`). Backups: 7-day automated. Endpoint lives in env vars on the running task.
- **Route 53:** `taraniscapital.com.` hosted zone `Z0680053Y587NB8B8C9S` (shared with website). `dataroom.taraniscapital.com` is an ALIAS A-record to the ALB.
- **Task role:** `arn:aws:iam::571600836975:role/taranis-dataroom-task-role` — attached policy `taranis-dataroom-s3-access` is correctly scoped to `arn:aws:s3:::taranis-dataroom-documents-prod/*` plus `ListBucket` on the bucket. Nothing broader.
- **Execution role:** the AWS default `ecsTaskExecutionRole`.
- **CloudTrail:** account-wide trail `taranis-capital-account-trail` (home region `us-east-1`, multi-region, log-file validation on, logs to `aws-cloudtrail-logs-571600836975-f495d2a6`). Management events only — S3 data events are **not** captured.

## Deploy

Primary path is **GitHub Actions CI** (`.github/workflows/deploy.yml`) — push to `main` triggers a build-and-deploy. Auto-deploy wired 2026-04-22 against the new least-privilege `taranis-dataroom-deploy` IAM user. Workflow builds api + web images, tags `:latest` + `:${{ github.sha }}`, pushes to ECR, pulls the current live task-def, updates container image SHAs, registers a new revision, rolls the service with `wait-for-service-stability: true`.

Fallback path is `deploy.bat` from PowerShell on Mark's Windows laptop — pinned to `AWS_PROFILE=TaranisCapital` so a `default` or `disruptsmedia` profile cannot deploy here by accident. `deploy.bat` tags `:latest` only (not `:${{ github.sha }}`) — switching it to unique tags is TASKS.md #15.

Local dev: `docker-compose up` — web at `http://localhost:5173`, api at `http://localhost:3001`. Vite dev server proxies `/api/*` to the api service (see `packages/web/vite.config.js`).

See `MIGRATION-INVENTORY.md` at the repo root for the full state-of-the-world.

## Secrets

- Runtime secrets live in **AWS Secrets Manager** (as of 2026-04-22): `taranis-dataroom/rds/master` (RDS password), `taranis-dataroom/jwt/signing` (JWT HMAC secret), `taranis-dataroom/seed/admin` (DR pre-position only, not runtime-referenced). ECS task-def `:6` references the first two via `secrets:` block. Access is via the inline policy `taranis-dataroom-secrets-access` on `ecsTaskExecutionRole`, scoped to those two specific ARNs only.
- RDS master password was rotated 2026-04-22 in the same window as the Secrets Manager migration. JWT signing secret was rotated in the same atomic window (it had been plaintext in the task-def env since the 8 April deploy). Quarterly rotation reminder on calendar.
- `.env` lives at the repo root for local dev — **must not** be committed (gitignored).
- **Never put secret values in committed files. Names and locations only.**
- After the 21 April 2026 history scrub, any reference to specific prior credential values (AWS key `AKIA…OP7D`, the prior RDS master password, the `Admin123!` seed default) lives only in `docs/incident/` with truncated identifiers.

## Five user roles

Admin, Investor, Advisor, Viewer (Consultant was merged into Advisor in migration 007). Permissions are three-dimensional: user × fund × category, with per-document overrides and per-role capability toggles.

## Seven document categories (post-migration 006)

Overview, Private Placement Memorandum, Legal Documents, Financials, Technical, Correspondence, Pitch Deck / Presentation. Seeded in migration 002, renamed and consolidated in 006.

## Do / don't

- **Do** rely on `MIGRATION-INVENTORY.md` at the repo root as the canonical operational reference — it supersedes `AWS_Deployment_Summary.md` (historical 8 April snapshot).
- **Do** keep every S3 PUT byte-for-byte identical to the source — no app-layer encryption, no base64, no re-encoding. SSE-S3 handles at-rest encryption transparently.
- **Do** run Prisma/raw-SQL migrations via the API startup path (`autoMigrate()` in `packages/api/src/index.js`) — they run before the API serves traffic.
- **Do** store files byte-for-byte in S3; metadata only in Postgres.
- **Do** use the `TaranisCapital` AWS profile (once a live key exists again) for any CLI work. `deploy.bat` should pin it explicitly so a `default` or `disruptsmedia` profile can never deploy here by accident.

- **Don't** touch the `audit_log` table, its triggers, or its retention. 8-year append-only retention is a DFSA commitment; UPDATE and DELETE are blocked at the trigger layer by design.
- **Don't** ever store file BLOBs in Postgres — metadata only (title, size, uploader, permissions, S3 key).
- **Don't** touch any website resources in the shared account — `taraniscapital.com` bucket, the six fund-subdomain CloudFront distributions (`E18AUIFBUGMXSB` etc.), the shared hosted zone, the `taranis-website-deploy` IAM user. That's a separate migration already signed off.
- **Don't** commit `.env`, build artefacts, `node_modules`, or anything under `uploads/`. All are gitignored.
- **Don't** hard-code user IDs or fund IDs in seeds — use generated UUIDs. As of 21 April the seed creates the admin user only; funds and data are admin-UI-managed.
- **Don't** use `git push --force` or history-rewriting operations on `main` without an explicit ask. One post-incident history scrub happened on 21 April 2026 — any future rewrite requires the same level of preparation (inventory, sign-off, backup branch, force-with-lease).

## Known gotchas carried forward

- **8-year `audit_log` retention is DFSA-aligned.** The table is append-only. Never prune, never alter the triggers, never drop. The triggers live in migration 004.
- **RDS password rotation atomic sequence.** The canonical ordering lives in `C:\Users\mark\Claude Cowork\Other\Admin\WORKFLOW.md` → "Atomic secret rotation sequence (RDS password + JWT) on a containerised stack" (corrected 2026-04-22 after executing in prod). Key point: Secrets Manager must initially hold the CURRENT RDS password before you roll the new task-def, then you update SM to the new value AND rotate RDS AND force-new-deployment in a single ~10-min freeze window. Out-of-order is a production outage.
- **"CloudFront OAC presigned URLs, 5-minute TTL" is a spec plan, not the implementation.** Today documents stream through the ECS API via the task role, not through CloudFront. If a user reports a broken PDF link, it's usually an auth-token timeout or an S3 key mismatch, not OAC.
- **`deploy.bat` uses `:latest` tags; CI uses `:latest` + `:${{ github.sha }}`.** Switching deploy.bat to unique tags is TASKS.md #15.
- **Frontend `VITE_API_URL` defaults to relative `/api`.** Any build without this env var set still produces a working bundle (nginx proxies). An earlier defaulting to `http://localhost:4000` caused a latent bug that only surfaced when cached JWTs were invalidated — fixed 2026-04-22. See `C:\Users\mark\Claude Cowork\Other\Admin\WORKFLOW.md` → "Latent bugs exposed during Tier 3 migrations" if planning a rotation elsewhere.
- **pg.Pool has explicit `ssl:` config in `packages/api/src/db.js`.** Gated on `PGSSLMODE`. Encrypt-without-verify (`rejectUnauthorized: false`) until the RDS CA bundle is shipped with the image (TASKS.md #13 paired with `rds.force_ssl=1`).

## Repo

- **GitHub:** `Walkerma75/taranis-dataroom` — **private**, personal account (not an org). Branch-protection and push-protection features on personal-account private repos are Pro-plan-only and were not available at the time of writing.
- **Branch:** `main`.
- **Filesystem:** working clone lives at `C:\Users\mark\Claude Cowork\Taranis Capital\Code\Taranis Dataroom\taranis-dataroom\`.

## Project files

- `MIGRATION-INVENTORY.md` — canonical operational reference (12-section Tier 3 inventory, first written 21 April 2026).
- `docs/incident/` — the 8 April 2026 secret-exposure incident record (inventory, CloudTrail review, README).
- `AWS_Deployment_Summary.md` — historical 8 April deployment snapshot; superseded by the inventory, kept for provenance.
- `README.md` — one-liner repo description.
- `../CLAUDE.md` — the Cowork-side briefing (outside the repo, deeper context, not committed here).
- `../Taranis_Data_Room_Project_Notes.md` — master project notes (outside the repo).
- `../Dataroom_Document_Handling_Approach.md` — portable write-up of the upload-to-S3 / metadata-in-Postgres pattern (outside the repo).

## Last updated

22 April 2026 (Tier 3 follow-up execution: TASKS.md #4/#5/#6 closed, JWT rotation folded in, three latent bugs fixed in code and documented as pre-flight checks in `C:\Users\mark\Claude Cowork\Other\Admin\WORKFLOW.md`).
