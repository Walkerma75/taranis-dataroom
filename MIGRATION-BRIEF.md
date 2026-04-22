# Migration Brief — Taranis Dataroom

**Project:** Taranis Capital Data Room — invite-only document portal for fund investors, advisors and consultants
**Repo:** `taranis-dataroom` (private) — working clone at `Claude Cowork/Taranis Dataroom/taranis-dataroom/`; GitHub org to be confirmed as `Taranis` on first session
**Live URL:** `https://dataroom.taraniscapital.com` (live since 8 April 2026)
**Risk tier:** **Tier 3** (per `../PROJECTS-REGISTER.md`) — first Tier 3 migration in the portfolio
**Purpose of this document:** Instructions for the read-only discovery pass that closes this project out for a Claude Code-driven workflow. Once the inventory is signed off on the register, handover is done.
**Owner:** Mark Walker
**Owner entity:** **Taranis Capital** (DFSA-regulated)
**Created:** 21 April 2026

---

## Why this one is different

This is the first Tier 3 project in the migration queue. Unlike the three Tier 2 sites already migrated, Taranis Dataroom is:

1. **A live application with real user data.** Investors, advisors and consultants log in, view PPMs, LPAs and financials, and their activity is captured in an append-only audit log. Any misfire during discovery is visible to real users within minutes.
2. **DFSA-aligned.** 8-year audit retention, Object-Lock-style immutability, EU-only data residency. Discovery must not touch the `audit_log` table, its triggers, or S3 Object Lock settings. These are regulatory controls, not operational ones.
3. **Multi-service on AWS.** ECS Fargate + RDS PostgreSQL + S3 + ALB + ACM + Route 53 + CloudFront OAC + ECR + Secrets Manager + IAM task roles. The blast radius of a misconfigured IAM or networking change is much larger than a static site.
4. **Sharing an AWS account with another live property.** `deploy.bat` pins to `AWS_PROFILE=TaranisCapital`, account **`571600836975`** — the same account that hosts the static Taranis Capital website and all five fund subdomains. Same shared-blast-radius discipline as Pro-curo Website / V5 on the shared Azure subscription: scope every action to the Dataroom's resources; do not touch subscription-wide settings or the static site's resources.
5. **Actively being built.** PDF watermarking, SES email wiring, WAF tuning and Terraform codification are all "outstanding" per the project notes. Discovery is a freeze frame on a moving target — the inventory has to note what's live vs planned without making commitments on either side.

So the discovery pass here has three jobs:

1. Pull the existing knowledge (CLAUDE.md, project notes, deployment docs, document-handling note) into a single `MIGRATION-INVENTORY.md` at the repo root.
2. Close the specific gaps — GitHub org confirmation, IAM policy enumeration, Secrets Manager inventory, DNS/cert audit, audit-log/Object-Lock verification.
3. Fix only the narrow, genuinely low-risk hygiene items that don't touch the running service.

Per Mark's call: same single-handover pattern as the three Tier 2 briefs — discovery → sign-off → **Migrated** — without an explicit parallel-run phase. Tier 3 discipline shows up in the *constraints*, not in a separate staged-handover model.

---

## What is already known (summary — do not re-document)

### Identity

- Purpose: invite-only portal for Taranis Capital fund documents (PPMs, LPAs, subscription agreements, technical annexes)
- State: **LIVE (beta)** — first investor cohort not yet onboarded; admin + a small pilot of internal users are exercising the system
- Owner entity: Taranis Capital (DFSA-regulated)
- Business owner: Mark Walker (founding partner)
- Live URL: `https://dataroom.taraniscapital.com`

### Tech stack (confirmed from `CLAUDE.md` + project notes)

- **Backend:** Node.js + Express + TypeScript, Prisma ORM, PostgreSQL 16
- **Frontend:** React (Vite) + TypeScript + Ant Design 5 + `@react-pdf-viewer/*`
- **Monorepo layout:** npm workspaces — `packages/api`, `packages/web`
- **Containers:** Docker + Docker Compose (local), ECS Fargate (prod)
- **Hosting:** AWS `eu-west-2` (ECS Fargate cluster `taranis-dataroom`, ALB, ECR repos `api` and `web`, RDS PostgreSQL 16, S3 bucket `taranis-dataroom-documents-prod`)
- **Auth:** JWT (15-min access, opaque refresh) + TOTP MFA + SMS fallback, Argon2id password hashing, per-user capabilities JSONB column
- **Access model:** explicit user × fund × category grants with per-document overrides; four roles (Admin, Investor, Advisor, Viewer) after Consultant was merged into Advisor
- **Audit:** append-only `audit_log` table, UPDATE/DELETE blocked at trigger level, 8-year retention (DFSA)
- **Document storage:** bytes → S3 (SSE-S3), metadata → PostgreSQL `documents` table, download is a proxied stream through the API with permission check + audit write. No BLOBs in Postgres. See `Dataroom_Document_Handling_Approach.md` for the full pattern
- **Email:** Amazon SES planned, **not yet wired**
- **Deploy:** `deploy.bat` from PowerShell — builds Docker images tagged `DR-0.1.0-b{YYYYMMDD.HHMM}`, pushes to ECR, triggers ECS `force-new-deployment`. Pins to `AWS_PROFILE=TaranisCapital`, account `571600836975`, region `eu-west-2`

### AWS (per ACCOUNTS.md + deploy.bat)

- **Account:** `TaranisCapital` (**`571600836975`**) — same account as the static website. ACCOUNTS.md row labelled `taranis-dataroom` is a workload label, not a separate account
- **Region:** `eu-west-2`
- **Secrets:** AWS Secrets Manager (DB creds, JWT signing secret, SES creds once wired)
- **IAM task role:** `taranis-dataroom-task-role` (S3 access) — created manually in the console by Mark, not in Terraform yet
- **Deploy IAM user:** "`taranis-deploy` (access key ending EE4G)" per project notes — **but** the Taranis Capital Website register row shows that `taranis-deploy` was replaced by `taranis-website-deploy` on 2026-04-20. One of two things is true: (a) this reference in the project notes is stale and the Dataroom now uses a different deploy principal, or (b) there are two accounts with the same short name in Mark's head. Bucket B verification item

### Repo

- Working clone: `Claude Cowork/Taranis Dataroom/taranis-dataroom/`
- Monorepo with `packages/api`, `packages/web`
- `.github/workflows/deploy.yml` present (confirm whether actually wired or placeholder)
- Deploy mechanism in practice today: the `deploy.bat` script, not CI/CD
- GitHub org: decision log says "existing Taranis org" (6 Apr 2026) — **confirm** on first session; register currently says `TBD (Taranis org?)`
- Branch protection on `main`: not known — assume off, verify
- Visibility: private (per CLAUDE.md + ACCOUNTS.md)

### Domains

- `dataroom.taraniscapital.com` — live ALB target, Route 53 record in hosted zone `Z0680053Y587NB8B8C9S` in the same AWS account
- `taraniscapital.com` — registrar e& (nic.ae), DNS at Route 53. Migrated from Funkygrafix 7 Apr 2026

### Document categories + roles (not a discovery concern, captured for completeness)

- Nine document categories: Overview, Private Placement Memorandum, Legal Documents, Financials, Technical, Correspondence, Pitch Deck / Presentation (plus two further categories per `CLAUDE.md` — confirm the final list of nine from the seed)
- Three funds at launch: Biotech, Datacentre, Property

### Outstanding build items (per `CLAUDE.md` — not discovery's concern, mentioned only to keep them visible)

- PDF watermarking at delivery time (user email + UTC timestamp)
- Amazon SES wiring (invites, broadcasts, MFA codes)
- WAF + rate-limiting tuning
- Terraform codification of the manually-provisioned AWS infra
- Replace placeholder logo with final Taranis SVG

### Known gotchas (from `CLAUDE.md`)

- 8-year retention on `audit_log` is DFSA-aligned — the table must never be pruned automatically. Append-only by design, enforced at trigger level
- RDS password rotation requires updating the ECS task definition's secret ARN when the version changes — rotation procedure is not yet written down
- CloudFront OAC presigned URLs have a 5-minute TTL — a user reporting a broken PDF link is almost always a stale URL, not a permissions problem
- Seed admin credential `admin@taraniscapital.com` / `Admin123!` — needs changing in production if it hasn't already been

### Working-tree drift (flagged from Cowork-side inspection, 2026-04-21)

- The local `.git` directory has both `HEAD.lock` and `index.lock` present, dated 8 April. Git is currently refusing commands in that clone. This is the same class of issue that hit the end of the Pro-curo Website discovery. Clear before anything else: `rm .git/HEAD.lock .git/index.lock` and confirm `git status` is clean (or reports expected uncommitted state). **Do this in step 1 of the execution plan, before reading anything else.**

Everything above gets carried forward verbatim into the inventory. Don't re-derive what's already written down.

---

## Scope of this discovery pass

Taranis Dataroom only. The static Taranis Capital website shares the AWS account but has already been migrated (register row #1, signed off 2026-04-20) — it is out of scope. Cross-account work (Disrupts Media `915079919298`, Pro-curo Azure subscriptions) is out of scope. Any resource in account `571600836975` that is *not* used by the Dataroom (i.e. is part of the static website's footprint — the `taraniscapital.com` S3 bucket, CloudFront distribution `E18AUIFBUGMXSB`, fund-subdomain buckets, etc.) must **not** be altered during this pass. Discovery lists those resources only to confirm they're there and unchanged.

---

## Gaps to close during this pass

Grouped by category. Most of this is AWS console + CLI verification, plus a git/config audit. Almost nothing here is conversational — the information lives in AWS, not in Mark's head.

### Bucket A — closed in Cowork conversation 21 April 2026

| Item | Answer |
|---|---|
| Working clone location | `Claude Cowork/Taranis Dataroom/taranis-dataroom/` **is** the canonical working copy |
| GitHub org | Taranis org (decision log, 6 Apr 2026). Register row still says `TBD (Taranis org?)` — verify the actual remote on first session and close |
| AWS account for the Dataroom workload | `TaranisCapital`, ID **`571600836975`**, region `eu-west-2`. Same account as the static Taranis Capital website — scope rules in Constraints |
| Registrar / DNS host for `taraniscapital.com` | e& (nic.ae) registrar; DNS at Route 53 zone `Z0680053Y587NB8B8C9S` — these carry over from the Website inventory; no need to re-derive |
| Handover model | Same single-handover pattern as the three Tier 2 briefs (Mark, 2026-04-21). No explicit parallel-run phase; Tier 3 discipline shows up in the Constraints section, not in a separate staged model |
| SES email | **Not yet wired.** Planned, not live. Do not "fix" the lack of SES inline — it's a build item, not a discovery gap |
| Repo visibility | **Private** (per CLAUDE.md + ACCOUNTS.md) — no public history exposure, but secret-history grep is still mandatory in case of future visibility flip |

**Lesson carried from Pro-curo:** the previous brief's Bucket A had two wrong answers (DNS host; region). Treat the Bucket A answers above as assumptions to verify in Bucket B, not facts to propagate unchanged. If the GitHub remote doesn't resolve to an org called `Taranis`, that's a correction — write it down and propagate it to the register + `ACCOUNTS.md`.

### Bucket B — AWS CLI + repo checks for the Claude Code session

Every `aws` call in this section assumes profile `TaranisCapital`, region `eu-west-2`, account `571600836975`. Scope every query by tag, resource name, or ARN to Dataroom-named resources where possible. If a command would list across the entire account without filtering (e.g. `aws s3 ls`), use it read-only and confirm the return matches expected inventory; never pass `--region us-east-1` unless checking the ACM certificate the distribution uses.

#### Git and access

- [ ] Clear the `.git/HEAD.lock` and `.git/index.lock` left on disk. Confirm `git status` runs cleanly
- [ ] Confirm the remote URL (`git remote -v`) — record the actual org and repo name. Close the `TBD (Taranis org?)` line on the register
- [ ] Enable branch protection on `main`: require linear history, disallow force-push, disallow branch deletion. Add required PR reviews if `Taranis` org is on GitHub Pro/Team (if it's on Free, branch protection on private repos is unavailable — log as a follow-up, as with Disrupts Media)
- [ ] Confirm MFA is enforced on the GitHub account that owns the repo
- [ ] Grep the repo's full history for leaked secrets: `AKIA`, `ASIA`, `aws_secret`, `aws_access`, `AIza`, `BEGIN RSA`, `BEGIN OPENSSH`, `private_key`, `postgresql://`, `JWT_SECRET`, `Admin123!`, `connectionstring`, `client_secret`. Any hit — stop and escalate before any further action
- [ ] `.gitignore` audit — confirm `.env`, `.env.*`, `packages/*/dist/`, `packages/*/build/`, `node_modules/`, `uploads/`, `*.log`, `.vscode/`, `coverage/` are ignored
- [ ] Confirm the seed admin credential (`admin@taraniscapital.com` / `Admin123!`) has been changed in production — if it hasn't, this is an **immediate** rotation follow-up in `TASKS.md`, not an inline fix

#### AWS — compute + networking

- [ ] Record ECS cluster `taranis-dataroom` details: service names, task definition ARNs (current and the three prior revisions — Fargate revision 4 per project notes), task role ARN, execution role ARN, service desired/running count, deployment circuit-breaker state
- [ ] Record the ALB: ARN, listeners (80/443), target groups, SSL policy, attached WAF (if any)
- [ ] Record the VPC: CIDR, public/private subnets, NAT gateway, route tables, security groups attached to ECS tasks and RDS
- [ ] Confirm HTTPS termination at the ALB — list the ACM cert ARN (eu-west-2 this time, not us-east-1) and expiry
- [ ] Record CloudFront distribution (if one is in front of the ALB — project notes reference OAC presigned URLs with 5-min TTL for S3, so a CloudFront distribution for document delivery almost certainly exists). List ID, default behaviour, WAF association, logging config
- [ ] ECR repositories `taranis-dataroom/api` and `taranis-dataroom/web` — confirm image scanning is on; record retention policy if any

#### AWS — data

- [ ] RDS instance: engine version, instance class, Multi-AZ status, storage size and type, backup retention window, automated backup window, latest restore time, Performance Insights status, parameter group, security group inbound rules (confirm only ECS SG can reach 5432)
- [ ] S3 bucket `taranis-dataroom-documents-prod`: versioning, SSE setting (SSE-S3 per CLAUDE.md — confirm), Object Lock status (DFSA requirement), public-access block (all four flags must be ON), bucket policy, lifecycle rules, access logging target. If Object Lock is OFF, that's a regulatory gap — log as a follow-up with a hard deadline, do not enable inline (Object Lock is an irreversible bucket-level change)
- [ ] Confirm no other dev/test/staging S3 buckets contain production documents
- [ ] Cross-Region Replication: project notes reference `CRR to eu-west-1` as part of the spec — confirm whether CRR is actually configured or still planned

#### AWS — IAM + Secrets

- [ ] Enumerate every IAM user with access to account `571600836975` (not just the deploy user). Confirm root MFA is on
- [ ] Confirm which deploy principal the Dataroom actually uses. Resolve the `taranis-deploy` vs `taranis-website-deploy` ambiguity — if the Dataroom is still using `taranis-deploy` while the website has moved to `taranis-website-deploy`, either (a) create a dedicated `taranis-dataroom-deploy` least-privilege user and schedule a cutover, or (b) if the Dataroom already has a dedicated user, document it and move on
- [ ] Dump the permissions policy JSON attached to whatever principal the Dataroom deploy actually uses — least-privilege review
- [ ] List every secret in AWS Secrets Manager that the Dataroom references: DB master password, DB application user password, JWT signing secret, SES credentials once wired, anything else wired into the ECS task definition via `secrets:` block. Record the ARN, last rotation date, rotation schedule (if any), KMS key used
- [ ] ECS task role `taranis-dataroom-task-role`: dump the attached policies. Confirm S3 access is scoped to `taranis-dataroom-documents-prod` only — not `*`
- [ ] CloudTrail: confirm management-events trail is on in `571600836975` (the website migration enabled trail `taranis-capital-account-trail` on 2026-04-20 — verify it covers Dataroom-touching API calls too)

#### DNS and certificates

- [ ] Record the Route 53 record set for `dataroom.taraniscapital.com` (zone `Z0680053Y587NB8B8C9S`). Confirm it points at the ALB and uses an alias record, not a CNAME
- [ ] ACM certificate for `dataroom.taraniscapital.com` — ARN, expiry, auto-renewal state, issuer
- [ ] If a CloudFront distribution is in use for document delivery, its ACM cert lives in `us-east-1` — record that ARN and expiry separately
- [ ] Confirm the `*.taraniscapital.com` wildcard is **not** being used as the Dataroom's cert (the website owns that wildcard; Dataroom should have its own cert to keep blast radii separate)

#### CI/CD and rollback

- [ ] Inspect `.github/workflows/deploy.yml` — is it wired with AWS credentials and actively used, or is it a placeholder? Today's deploy is via `deploy.bat` from Mark's laptop. Record the answer
- [ ] Document the exact `deploy.bat` sequence: ECR login → `docker build` api + web → `docker push` with unique tag `DR-0.1.0-b{YYYYMMDD.HHMM}` → `aws ecs update-service --force-new-deployment`
- [ ] Rollback procedure for a bad deploy: ECS keeps the prior task definition; rollback is "update-service to the prior task-definition revision" + wait for the circuit breaker. **Write this down in the inventory with the exact CLI.** Do **not** run the drill live — pulling a live Fargate service back to a prior revision is not a low-risk action on a Tier 3 system. Log a scheduled rollback drill in `TASKS.md` with a deadline
- [ ] Prisma migrations: confirm the entrypoint script runs migrations before the API container serves traffic (per `CLAUDE.md`). Record the migration naming convention and the current head migration
- [ ] Confirm whether anyone else can trigger a deploy — if `deploy.bat` is Mark-only on Mark's laptop, that's a bus-factor-of-one risk to log

#### Third-party integrations

- [ ] GA / analytics / monitoring: list anything injected into the React app or the API middleware. Record the IDs (not keys)
- [ ] SMS fallback for MFA: identify the provider (Twilio? SNS SMS? AWS End User Messaging SMS?) — where are its credentials stored, who holds the account
- [ ] PDF renderer library CDN calls — confirm `@react-pdf-viewer/*` doesn't phone home to an unexpected origin

#### Database

- [ ] Record Postgres engine version, schema version (current Prisma migration head), the five migrations named in the project notes (users/MFA/tokens/invites; funds/documents; permissions; audit triggers; notices) + any additions beyond migration 007 (capabilities JSONB)
- [ ] Record backup retention (RDS automated + any manual snapshots), the backup window, and whether any restore has been tested. If no restore has been tested, scheduled restore drill goes into `TASKS.md` with a hard deadline — this is the single most important Tier 3 control
- [ ] Confirm the `audit_log` triggers preventing UPDATE/DELETE are live on the production DB. Query `pg_trigger` read-only; do not touch them
- [ ] Confirm the DB role used by the application is **not** the RDS master user — the app should use a role without DDL privileges and without the ability to drop `audit_log`

#### Monitoring and alerting

- [ ] CloudWatch: list log groups for the ECS tasks and ALB. Confirm retention is set (default is "never expire" — cost risk). Confirm no PII is being logged from the request path
- [ ] CloudWatch alarms: what exists? ALB 5xx rate, ECS service unhealthy count, RDS CPU / connections / storage, Secrets Manager rotation failures. If nothing exists, the allowed inline fix is a minimal alarm set on ALB 5xx + ECS service healthy count, SNS target email to `mark@taraniscapital.com`. Do **not** enable anything that costs materially (X-Ray, Container Insights, CloudWatch Synthetics) without Mark's approval
- [ ] Confirm SES bounce/complaint handling — once SES is wired (it isn't yet), this becomes a gap. For now, note it as "deferred until SES wiring"

#### Backup and DR

- [ ] RDS automated backups: retention window, point-in-time-recovery latest restore time, last tested restore (almost certainly "never")
- [ ] S3 bucket: versioning + Object Lock status (see Data section) — these are the document-level backstop
- [ ] Secrets Manager: confirm secrets are in the `eu-west-2` replica region only, or also replicated to `eu-west-1` if CRR is set up
- [ ] Write the restore-from-nothing procedure into the inventory explicitly — new account (or same account, clean RG-equivalent), `terraform apply` (once Terraform exists; today it's "re-run AWS console clicks using this inventory as the runbook"), restore RDS from snapshot, restore S3 from versioning or CRR replica, push ECR images, `deploy.bat`. Time estimate end to end: note whatever Mark's best guess is — probably 4–8 hours with zero prior automation

#### Tribal knowledge

- [ ] Why the access model is three-dimensional (user × fund × category) rather than role-based — the answer is in the spec but not in the repo. Capture
- [ ] Why Consultant was merged into Advisor (spec had five roles; built with four)
- [ ] Why audit is append-only at DB trigger level rather than at application level (defence in depth — a compromised app service can't lose audit trail)
- [ ] The CloudFront OAC 5-min TTL stale-URL class of bug — already in `CLAUDE.md`, carry into the inventory
- [ ] Document categories — the final nine (or seven + two) as seeded vs. what the spec originally proposed
- [ ] The fact that `deploy.bat` pins `AWS_PROFILE=TaranisCapital` explicitly, to stop an accidental `disruptsmedia` profile deploy from Mark's machine where three AWS profiles coexist

#### Known risks and open items

- **Shared AWS account with the live static website.** All work scoped to Dataroom resources. No subscription-wide, sorry, account-wide changes (see Constraints)
- **SES production-access status.** The Disrupts Media migration turned up that SES production access was denied (case `177618481600800`). Confirm whether the same case covers the `TaranisCapital` account or whether Dataroom SES production access is a separate ticket. If Dataroom expects production-volume SES for MFA codes + broadcasts, go-live is blocked on approval
- **Seed admin credential still `Admin123!`?** If production hasn't rotated, this is a live-exposure incident, not a discovery finding. Get a clear answer from Mark before ticking any "discovery clean" box
- **No restore drill ever run** on either RDS or S3. Log as hard-deadline follow-up
- **Object Lock on the documents bucket** — DFSA retention story depends on it. If off, that's the single biggest regulatory gap to close (not inline — Object Lock is a bucket-level commitment that cannot be removed)
- **Bus-factor-of-one on deploy.** `deploy.bat` is Mark's laptop only. CI/CD workflow exists at `.github/workflows/deploy.yml` but may not be wired. Log the migration from laptop-deploy to CI-deploy as a post-handover follow-up
- **Working-tree drift on the local clone.** `HEAD.lock` + `index.lock` from 8 April. Clear first, verify last (same lesson as Pro-curo)

---

## Expected output

A new file at the repo root of `taranis-dataroom/`:

**`MIGRATION-INVENTORY.md`**

Following the twelve-section template in `../../PROJECTS-REGISTER.md` (Identity, Git, Cloud, Secrets, CI/CD, DNS, Third-party, Database, Monitoring, Backup/DR, Tribal knowledge, Known risks). **Database is a full section here** (unlike the Tier 2 briefs) — this project's DB is regulated, audit-trigger-protected, and production-critical.

Also: a new repo-level `CLAUDE.md` (copy and adapt the Cowork `CLAUDE.md`, with the AWS account ID and region inlined, the Taranis Capital identity rule preserved, and the shared-account discipline added).

The inventory should be a document that a new engineer could read in 25 minutes and, on its basis, take over the application with no further briefing. Tier 3 is unforgiving — if the inventory is missing a section, the first incident response will be a scramble.

---

## Execution plan

Run this in a Claude Code session rooted at `Claude Cowork/Taranis Dataroom/taranis-dataroom/` (the confirmed working clone).

1. **Clear the working-tree drift.** `rm .git/HEAD.lock .git/index.lock`, then `git status` to confirm the repo is usable. If `git status` returns anything unexpected beyond known uncommitted work, **stop and ask Mark** — don't start committing until the repo is in a known state.

2. **Read the existing context.** In order: this brief, `../CLAUDE.md` (the Cowork-side briefing), `../Taranis_Data_Room_Project_Notes.md`, `../Dataroom_Document_Handling_Approach.md`, the `Taranis_Data_Room_Product_Specification.docx` (use `docx` skill), the repo's own `README.md`, `DEPLOY_NOW.md`, `AWS_Deployment_Summary.md`, and `docker-compose.yml`. No changes yet.

3. **Grep for secrets across the repo's full history** (not just the working tree). Patterns in Bucket B / Git and access. Any hit → stop, escalate, do not commit anything, do not continue.

4. **Seed the inventory.** Create `MIGRATION-INVENTORY.md` in the repo root, using the twelve-section template with Bucket A answers pre-filled. Mark every unverified item `[CONFIRM]`.

5. **Copy + adapt the CLAUDE.md.** Put a repo-level `CLAUDE.md` at the repo root. Don't paste the Cowork path or any secrets — just the account ID, region, bucket names, cluster name, task role ARN (names not values), and the shared-account discipline.

6. **Close Bucket B section by section.** For each item:
   - If Claude can determine it from the repo or from AWS CLI (`aws sts get-caller-identity`, `aws ecs describe-services`, `aws rds describe-db-instances`, `aws s3api get-bucket-versioning`, etc.) against the confirmed account, do so and fill the inventory
   - If the item is on the narrow allowed-inline list for this project (below), fix it and record in the "Changes made during discovery" block at the top of the inventory
   - Anything that rotates secrets, changes IAM policies, alters DNS, touches the ALB/CloudFront, modifies the audit log, alters Object Lock, changes the CI/CD workflow, or restarts a running container goes into `TASKS.md` as a follow-up — not an inline fix, regardless of how obvious it seems
   - If an item needs Mark to look at a console or supply an external fact (GitHub org name in practice, SES production-access ticket status, etc.), it stays `[CONFIRM]` and moves to a "Questions for Mark" block at the top of the inventory

7. **Do NOT run a rollback drill on Fargate live.** Document the rollback CLI; schedule the drill in `TASKS.md` with a deadline. Tier 3 difference from the Tier 2 briefs.

8. **Review questions with Mark.** Short list of only the unresolved items. Mark answers in one batched pass, Claude updates the inventory.

9. **Cross-check against the register.** Open `../../PROJECTS-REGISTER.md` and close every Taranis Dataroom-touching line in the "Gaps to resolve" block. Strike through in that file.

10. **Update the register and sign-off.** Revise register row #2:
    - Git account / repo → `<org>/taranis-dataroom` (confirmed)
    - Cloud account / subscription → `TaranisCapital (571600836975)` (corrects the misleading `taranis-dataroom` label)
    - Region → `eu-west-2`
    - Secrets primary location → AWS Secrets Manager (enumerate secret names in the inventory, not here)
    - Discovery status → **Discovery complete**
    - Inventory doc → link to the committed `MIGRATION-INVENTORY.md` in the repo
    - Handover status → **Migrated** (subject to Mark's written sign-off)
    - Tick the handover checklist items that genuinely passed. Mark unticked items as follow-ups in `TASKS.md` with deadlines

---

## Inline fixes — narrow, conservative list for a Tier 3 project

Per the `../../PROJECTS-REGISTER.md` Discovery policy, only additive, reversible, non-service-touching fixes are allowed. For this project specifically, the allowed inline list is:

1. **Branch protection on `main`** (if the GitHub plan permits on a private repo): linear history, no force-push, no branch deletion. No required reviews (solo repo).
2. **`.gitignore` additions** — anything obvious missing from the list in Bucket B / Git.
3. **Minimal CloudWatch alarm set** on ALB 5xx rate + ECS service running-count, with an SNS topic emailing `mark@taraniscapital.com`. Cost is under £1/month. If either resource already has alarms, skip and note.
4. **Enable S3 bucket versioning** on `taranis-dataroom-documents-prod` if off. Additive, reversible, cheap.
5. **Enable ECR image scanning** on both repos if off. Additive, zero runtime impact.
6. **Enable CloudTrail data events for the documents bucket** only if CloudTrail is already on in the account (check website migration's trail `taranis-capital-account-trail`). Additive. If CloudTrail is off at the account level, do not enable — that's a bigger decision with subscription-wide cost implications; log it as a follow-up.

Everything else — Object Lock, KMS CMK adoption, WAF rules, CI/CD rewiring, IAM policy tightening, CRR enablement, Terraform adoption, rotation of the seed admin credential, rotation of any secret in Secrets Manager, moving from `deploy.bat` to GitHub Actions — is a follow-up in `TASKS.md`, not an inline fix.

**Rule of thumb reminder:** if an investor could wake up at 3 am because of this change, it's not low-risk.

---

## Constraints

- **Live DFSA-regulated application with real user data.** Don't touch running containers. Don't modify the running task definition. Don't touch DNS or the ALB. Don't touch the `audit_log` table or its triggers. Don't alter Object Lock, SSE, or bucket policy on the documents bucket. Don't restart, don't scale, don't drain.
- **Shared AWS account with the live static website. Stay scoped to Dataroom resources.** Account `571600836975` also hosts the `taraniscapital.com` S3 bucket, CloudFront `E18AUIFBUGMXSB`, fund-subdomain buckets, and the Route 53 hosted zone. Discovery must: (a) scope every resource modification to Dataroom-named resources (`taranis-dataroom*`, `dataroom.taraniscapital.com`), (b) not modify account-level settings (root MFA already on — leave it; CloudTrail already on — leave it; do not add new account-wide SCPs, policies, or defaults), (c) not touch the static website's buckets, distributions, or DNS records other than reading them to confirm presence.
- **Regulatory controls are not operational controls.** The 8-year audit retention, append-only triggers, Object Lock (if on), and EU-only data residency are DFSA commitments. They are not "optional hardening" to be tweaked during discovery. If a change would weaken any of them even accidentally, it is a follow-up requiring Mark's explicit approval, not an inline fix.
- **No rollback drill inline.** Document the rollback; do not execute it. Schedule a drill in `TASKS.md` with a deadline. Tier 2 projects ran their drills inline — Tier 3 does not.
- **Monthly cost.** Anything over ~£5/month gets Mark's approval before turning on. Container Insights, X-Ray, CloudWatch Synthetics, Performance Insights on RDS paid tier, WAF managed rule groups — all follow-ups, not inline fixes.
- **Don't commit secrets.** Pre-commit grep in step 3 is non-negotiable. No `.env`, no `Admin123!` in markdown, no access-key-ID tails, no Secrets Manager ARNs that reveal version suffixes. Names and locations only.
- **Don't pull portfolio-wide secrets into the repo.** `ACCOUNTS.md` stays in Cowork. The repo's `CLAUDE.md` names only the AWS account, region, and specific resources this project uses.
- **Taranis Capital identity.** All prose in UK English, matching the tone of the existing `CLAUDE.md` and the prior briefs. Never reference Pro-curo on this property (spec v1.0 references were already flagged as errors in the project notes; do not reintroduce them).

---

## When this is done

The register row reads:

> Discovery status: **Discovery complete** · Inventory doc: link to `MIGRATION-INVENTORY.md` in the `taranis-dataroom` repo · Handover status: **Migrated**

And the portfolio has its first Tier 3 migration banked. Useful precedent for Pro-curo V5 and Pro-curo Licence Server — both also Tier 3, both on the shared Azure subscription. The constraints and inline-fix narrowness defined in this brief become the template for those two.
