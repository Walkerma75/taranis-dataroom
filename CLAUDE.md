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
- **Storage:** documents in S3 bucket `taranis-dataroom-documents-prod` (bytes byte-for-byte; metadata in Postgres). Wired in Phase 0, 2026-08-05 — before that, uploads went to container-local disk and were destroyed on every deploy. `packages/api/src/services/storage.js` is the injectable interface; `S3_BUCKET` and `AWS_REGION` come from the ECS task definition, not from the repo.
- **Tests:** Node 20's built-in `node:test` / `node:assert`. `npm test` at the root, or `npm -w packages/api run test`. No test framework dependency. S3 is exercised against an in-memory double, never against a real bucket; the database is exercised against a fake pool injected via `setPool()` in `packages/api/src/db.js`, so the whole suite runs with no container and no network.
- **Virus scanning:** `packages/api/src/services/scanner.js`, same injectable shape as storage. **The backend that ships is a STUB that scans nothing and never returns `clean`.** Company uploads are therefore served to reviewers without ever having been inspected. That is an **accepted beta risk, decided by Mark on 2026-08-06 — do not re-raise it as a blocker** (HANDOVER-C004 §3.1). Read the first entry in `MIGRATION-INVENTORY.md` §12 for the scope of the acceptance, the download rule, and the trigger to revisit (widening the client cohort).

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

## User roles

**Fund side:** Admin, Investor, Advisor, Viewer (Consultant was merged into Advisor in migration 007). Permissions are three-dimensional: user × fund × category, with per-document overrides and per-role capability toggles.

**Company side:** `company` (migration 010) — a due diligence counterparty. Deliberately outside the fund permission matrix entirely: a company user holds no `grants`, no `document_overrides` and no `permission_templates`, and every fund-side router rejects the role explicitly via `rejectCompanyRole`. Their capability comes from the `company_users` membership record (`company_admin` / `company_contributor` / `company_viewer`), not from the global role.

Their JWT carries a `companyId` claim, and **every `/api/company/*` route resolves its scope from that claim and never from a client-supplied id.** Membership and company status are re-read from the database on each request, so a deactivated user or a suspended company loses access at once rather than at token expiry. `packages/api/test/company-isolation.test.js` is the proof and should be extended, never weakened, whenever a company-side route is added.

**MFA is mandatory for role `company` only.** Other roles keep today's opt-in behaviour, deliberately: forcing enrolment on live investor and advisor users mid-release would lock people out of a portal they already use (HANDOVER-C003 §5.5). A company user who has not enrolled gets an `mfaPending` token that reaches `/auth/mfa/setup` and `/auth/mfa/verify` and nothing else. `requireAuth` rejects that token by default, so no new route can forget the check; the two enrolment endpoints opt in with `requireAuthForMfaEnrolment`.

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
- **RDS password rotation atomic sequence.** The canonical ordering lives in `MIGRATION-INVENTORY.md` Appendix B (corrected 2026-04-22 after executing in prod). Key point: Secrets Manager must initially hold the CURRENT RDS password before you roll the new task-def, then you update SM to the new value AND rotate RDS AND force-new-deployment in a single ~10-min freeze window. Out-of-order is a production outage.
- **"CloudFront OAC presigned URLs, 5-minute TTL" is a spec plan, not the implementation.** Today documents stream through the ECS API via the task role, not through CloudFront. If a user reports a broken PDF link, it's usually an auth-token timeout or an S3 key mismatch, not OAC. This was deliberately kept at the Phase 0 S3 cutover: streaming through the API preserves the grant checks and audit writes on every byte served.
- **No `S3_BUCKET` means local disk, silently but loudly.** With `S3_BUCKET` unset the API falls back to `packages/api/uploads` so `docker compose up` still works, logs `[storage] Documents backed by local disk …` at startup, and reports `"storage": "local"` on `/health`. If a production task ever shows `local` there, uploads are being written to ephemeral storage again.
- **Every document row created before 2026-08-05 is `archived`.** Migration `009_archive_pre_s3_documents.sql` did this at the S3 cutover: those rows' files were lost to ephemeral container storage long before, so leaving them `active` would have advertised documents that 404 on click. Rows were kept, not deleted, so `audit_log` entries still resolve. `s3_cutover_archived_documents` records exactly which rows were changed, and reversing is one UPDATE joined to it.
- **A company cannot be activated without BOTH gates.** `nda_executed_at` and `iems_screened_at` must both be recorded before `POST /companies/:id/activate` will do anything. The rule lives in the service layer, not a DB constraint, so the admin gets a readable refusal. The first real cohort exercises it: IMALIA holds an executed NDA but has no IEMS screen on record and must stay unactivatable. Activation is also what seeds the checklist, from the newest IRL template for the fund; seeding is idempotent, so re-activating adds nothing.
- **IRL `ref` values are permanent identifiers.** '1.1' style, unique per template and per company, quoted back by companies in correspondence and used in the PRE-FILLED and GAPS working files. **Never renumber them.** Display order lives in `sort_order` so an insertion never forces a renumber. The Biotech KSA master is a committed artefact at `packages/api/src/db/seeds/biotech-ksa-irl-v1.json` (146 items, 14 sections, priorities 42 high / 43 medium / 61 standard), regenerated from the fund-paperwork spreadsheet by `tools/build-irl-seed.mjs` and imported either with `npm -w packages/api run seed:irl -- --fund biotech-ksa` or, without a shell on the container, with `POST /api/irl-templates/seed  {"fundSlug":"biotech-ksa"}` (admin only). Both go through `runIrlImport()`, so there is one importer and one set of rules. The JSON is committed because the API container cannot read the workstation path the spreadsheet lives on, and because it lets the tests assert those counts hermetically — the endpoint therefore imports a committed artefact, never an upload. **Importing is idempotent by upsert, not by refusal:** a re-run rewrites only rows that differ from the master and reports the rest as unchanged, and it never renumbers a ref or deletes a row that has left the master, because a company may already have been asked for it.
- **`company_irl_items.internal_note` must never reach a company.** It is stripped by `companySafeItem()` on every company-facing response and is not part of the shape the Excel exporters accept, so the GAPS sheet cannot carry one even if someone forgets to exclude it at the query. Both are asserted in the tests.
- **Shared documents go Taranis to company only, and withdrawal is soft.** `company_shared_files` (migration 014) is the one path where bytes leave Taranis for a counterparty. The company side (`GET /api/company/shared-files` and its download) is strictly read-only and there is no route behind an edit, a delete or a re-publish. Withdrawing sets `withdrawn_at` and `withdrawn_by`; **nothing ever deletes a row or removes the S3 object**, so a document a company downloaded before it was pulled is still accounted for. Reinstating means publishing again as a new row. Keys live under their own `taranis-shared/` prefix, disjoint from `companies/` and `documents/`. Shared files are scanned through the same `scanner.js` interface and the same `downloadDecision` rule as company uploads, so a real backend tightens both directions at once; the reasoning is written into `services/company-shared.js`. One deviation from the code brief §9 audit list: the action is `company_shared.published`, not `company_shared.uploaded`, because "uploaded" means company to Taranis everywhere else.
- **No email anywhere in Phase 1a.** Invitations issue a link for an admin to send by hand, and the Review Queue page is the substitute for upload notifications. SES is Phase 1b and is gated on AWS production access.
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

6 August 2026 (Taranis-to-company shared documents: migration 014 `company_shared_files`, admin publish / list / soft-withdraw / read-back routes, a read-only company-portal list and download, a Shared documents tab on CompanyDetailPage and a From Taranis page in the company portal — see `Code/Handover/HANDOVER-C005-*.md` §3.5).

Previously 6 August 2026 (DD Portal Phase 1a: company role and isolation middleware, migrations 010 to 013, company portal and admin routes, the seven new screens, mandatory MFA for the company role, the Biotech IRL seed importer, the PRE-FILLED and GAPS exports, and virus scanning behind a stubbed interface — see `Code/Handover/HANDOVER-CW004-*.md`).

Previously 5 August 2026 (DD Portal Phase 0: document storage moved to S3, first test harness added, pre-cutover document rows archived by migration 009 — see `Code/Handover/HANDOVER-C003-*.md`).

Previously 22 April 2026 (Tier 3 follow-up execution: TASKS.md #4/#5/#6 closed, JWT rotation folded in, three latent bugs fixed in code and documented as pre-flight checks in `C:\Users\mark\Claude Cowork\Other\Admin\WORKFLOW.md`).
