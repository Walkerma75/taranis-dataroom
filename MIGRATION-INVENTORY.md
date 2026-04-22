# Taranis Dataroom — Migration Inventory

**Purpose:** canonical state-of-the-world reference for the Taranis Capital Data Room. Written during the Tier 3 discovery pass on 21 April 2026. Supersedes `AWS_Deployment_Summary.md` (historical 8 April deployment snapshot, kept for provenance only).

**Live URL:** <https://dataroom.taraniscapital.com>
**Repo:** <https://github.com/Walkerma75/taranis-dataroom> (private)
**AWS:** `TaranisCapital` (`571600836975`), region `eu-west-2` — **shared with the live static `taraniscapital.com` website**
**Owner entity:** Taranis Capital (DFSA-regulated)
**Business owner:** Mark Walker

A new engineer should be able to pick this up in 25 minutes and own the application. If a section is missing the answer, the honest answer — `UNKNOWN`, `NOT CONFIGURED`, or `PENDING (see TASKS.md)` — is written in place of a fabricated one.

---

## Changes made during discovery

Every inline change applied during the 21 April 2026 session. Each entry has a one-line revert path.

| Date | What | Why | How to revert |
|---|---|---|---|
| 2026-04-21 | Cleared `.git/HEAD.lock` + `.git/index.lock` (both zero-byte, dated 8 April) | Git refused commands until cleared | Not revertable (and no value in reverting — the locks were stale OS crumbs) |
| 2026-04-21 | Created branch `wip/bulk-upload-8-apr` from then-HEAD `91f3d21` capturing 8 April in-progress work (bulk upload + hardening). Pushed to `origin/wip/bulk-upload-8-apr`. | Protect in-flight work before rewriting `main` | `git push origin --delete wip/bulk-upload-8-apr && git branch -D wip/bulk-upload-8-apr` (but: that's the only copy of Mark's 8 April work post-scrub — don't revert) |
| 2026-04-21 | Created commit `8bec265 security: scrub hard-coded default admin password, add incident artefacts` on `main`, which: (a) rewrites `packages/api/src/db/seed.js` to admin-user-only, env-var password, never-overwrites; (b) rewrites `autoSeed()` in `packages/api/src/index.js` the same way; (c) removes two `echo`-lines from `deploy.bat` that printed the old default admin credential; (d) replaces an `Admin123!` line in `AWS_Deployment_Summary.md` with guidance pointing at `SEED_ADMIN_PASSWORD` + this inventory; (e) deletes `DEPLOY_NOW.md` entirely (live AWS keys, RDS password, default admin credential); (f) adds `docs/incident/` (secrets inventory, CloudTrail review, README). | Pre-scrub cleanup so file content at HEAD is secret-free before filter-branch rewrites prior commits | `git revert 8bec265` (but: would re-introduce the `Admin123!` hard-code — don't revert) |
| 2026-04-21 | Ran `git filter-branch --tree-filter` across all refs: deleted `DEPLOY_NOW.md` from every prior commit; replaced four literal secret strings (the AWS access key, its secret, the RDS master password, the `Admin123!` default) with `REDACTED-*` placeholders. Verified zero hits post-scrub. | 8 April secret exposure committed and pushed to `origin/main`; remediation required history rewrite. | Not revertable — the tar backup at `../taranis-dataroom.backup-2026-04-21.tar` (1.7 MB, includes `.git/`) preserves the pre-scrub state if a rollback is ever needed. Also: `wip/bulk-upload-8-apr` branch has the same pre-scrub trees as `main` did, just post-scrubbed — it carries forward the 8 April work. |
| 2026-04-21 | Force-pushed `main` (`2cf91ce` → `8bec265`) and `wip/bulk-upload-8-apr` (`c684a5a` → `f91d6d2`) to `origin` with `--force-with-lease`. | Publish the scrubbed history | Would require re-uploading from the tar backup and another force-push — very high-cost rollback; not recommended. |

Explicitly **checked and not applied**:

| Item | Status | Reason |
|---|---|---|
| Branch protection on `main` | Not applied | `Walkerma75` is a personal GitHub account (not an organisation). Branch protection on private repos requires GitHub Pro. Logged as follow-up in `TASKS.md`. |
| `.gitignore` additions | Not applied inline | Existing `.gitignore` already covers `node_modules/`, `dist/`, `.env`, `.env.*`, `uploads/*` (allowing `uploads/.gitkeep`), `*.log`, `.DS_Store`, `Thumbs.db`, `desktop.ini`. Local working tree has a slightly-reworded version (duplicate `node_modules` lines removed, `Thumbs.db` + `desktop.ini` added) that was captured on `wip/bulk-upload-8-apr`. No further additions needed. |
| CloudWatch alarms (ALB 5xx + ECS running count → SNS) | Not applied | My discovery credential is `ReadOnlyAccess` only — no write permissions. Logged as follow-up. |
| S3 versioning on `taranis-dataroom-documents-prod` | **Already on.** Verified via `aws s3api get-bucket-versioning` → `Status: Enabled`. Skip. | |
| ECR image scanning on `taranis-dataroom/api` + `/web` | **Already on.** `scanOnPush: true` on both. Skip. | |
| CloudTrail data events on the documents bucket | Not applied | Requires `cloudtrail:PutEventSelectors` which `ReadOnlyAccess` doesn't grant. Logged as follow-up. |

---

## Questions for Mark

Open items that could not be resolved from the repo, brief, ACCOUNTS.md, or AWS CLI calls. All non-urgent — none blocks handover.

### Still open

1. **GitHub secret-scanning / push-protection alert for `AKIA…OP7D`.** Did you receive an email from GitHub between 8 Apr and the key's deactivation? If yes, that explains the CloudTrail negative and reframes the incident as "detection worked". Either way the outcome's the same, but helpful for the post-mortem in `docs/incident/README.md`.
2. **AWS GuardDuty / Trusted Advisor.** Is GuardDuty enabled in account `571600836975`? Did Trusted Advisor's "Exposed Access Keys" check ever fire? `ReadOnlyAccess` doesn't show me GuardDuty detector state directly.
7. **SES production-access status for this account.** The Disrupts Media brief surfaced that SES production access was denied on another account (case `177618481600800`). Has Taranis Capital a live SES production-access approval, or is the Dataroom's SES wiring blocked on the same sandbox→production ticket? Blocks invite + MFA-code emails when SES is wired.

### Closed 2026-04-22

3. **~~`NODE_TLS_REJECT_UNAUTHORIZED` env var~~** — confirmed `0` on task-def `:4`. **Removed entirely** from task-def `:5`/`:6`. The latent pg-SSL bug it was masking is now fixed in code (`packages/api/src/db.js` sets explicit `ssl: { rejectUnauthorized: false }` gated on `PGSSLMODE`).
4. **~~`PGSSLMODE` env var~~** — confirmed `require` on task-def `:4`, retained. Upgrade to `verify-full` paired with TASKS.md #13.
5. **~~`NODE_ENV` env var~~** — confirmed `production` on task-def `:4`, retained.
6. **~~Seed admin credential~~** — pre-positioned as `taranis-dataroom/seed/admin-6Wa82t` in Secrets Manager, deliberately **not** referenced from the running task-def. Exists for DR restore-from-blank-DB only.
8. **~~Deployment process owner~~** — CI wired up. `taranis-dataroom-deploy` IAM user created 2026-04-22 with least-privilege policy, GitHub repo secrets updated, auto-deploy on push to `main` now active. `deploy.bat` pinned to `AWS_PROFILE=TaranisCapital`. Bus-factor reduced.

---

## Deferred follow-ups logged to TASKS.md

Short index (the full entries with deadlines and commands live in `../../TASKS.md` under the "Taranis Dataroom" heading):

| # | Item | Priority | Deadline |
|---|---|---|---|
| 1 | **Enable S3 Object Lock** on `taranis-dataroom-documents-prod` (DFSA retention gap — currently OFF) | Tier 1 | 2026-05-15 |
| 2 | **Restore drill**: RDS point-in-time + S3 versioning recovery end-to-end, documented | Tier 1 | 2026-05-31 |
| 3 | **Rollback drill**: CLI documented here; execute on Fargate live to prove procedure works | Tier 1 | 2026-05-31 |
| 4 | **Create `taranis-dataroom-deploy` IAM user** (replaces deactivated `taranis-deploy`) with least-privilege policy scoped to Dataroom ECR, ECS cluster/service, and S3 bucket — **NOT** account-wide | Tier 1 | 2026-04-30 |
| 5 | **Move secrets into Secrets Manager** (DB password, JWT signing secret, forthcoming SES creds, any `SEED_ADMIN_PASSWORD`). Register new ECS task-definition revision referencing Secrets Manager via the `secrets:` block | Tier 1 | 2026-05-07 |
| 6 | **Rotate RDS master password** after items 4 and 5 — atomic ordering in `TASKS.md` | Tier 1 | immediately after item 5 |
| 7 | SES production-access status resolution (confirm coverage on `TaranisCapital` account) | Tier 2 | 2026-05-07 |
| 8 | Encrypt RDS storage at rest (new encrypted instance via snapshot + restore + DNS cutover). DFSA compliance improvement | Tier 2 | 2026-06-30 |
| 9 | Enable S3 CloudTrail data events on the documents bucket (allowed-inline item, blocked by my readonly scope) | Tier 2 | 2026-05-15 |
| 10 | Minimal CloudWatch alarms (ALB 5xx rate, ECS running-count, RDS CPU/storage, Secrets Manager rotation failure) → SNS email to `mark@taraniscapital.com` | Tier 2 | 2026-05-15 |
| 11 | Add CloudWatch log-group retention to `/ecs/taranis-dataroom` (currently never-expire) | Tier 2 | 2026-05-15 |
| 12 | Upgrade ALB SSL policy from `ELBSecurityPolicy-2016-08` to a TLS 1.3 policy (e.g. `ELBSecurityPolicy-TLS13-1-2-2021-06`) to match the "TLS 1.3 only" spec line | Tier 2 | 2026-05-31 |
| 13 | Enable RDS `deletion-protection` + flip `rds.force_ssl` from `0` to `1` on the parameter group (requires reboot) | Tier 2 | 2026-05-31 |
| 14 | Enable WAF on the Dataroom ALB (spec called for rate-limiting + OWASP rule set) | Tier 2 | 2026-06-30 |
| 15 | Switch `deploy.bat` + GitHub Actions workflow to unique-tag images (e.g. `DR-0.1.0-b{YYYYMMDD.HHMM}`) so ECS deterministic rollback is possible | Tier 2 | 2026-05-31 |
| 16 | Turn on ECS deployment circuit breaker with rollback on the service | Tier 2 | 2026-05-15 |
| 17 | Enable GitHub push-protection for AWS keys on the repo (Settings → Code security) | Tier 3 | 2026-05-07 |
| 18 | Fail-fast guard for `JWT_SECRET` in `packages/api/src/services/auth.js` when `NODE_ENV=production` | Tier 3 | 2026-05-15 |
| 19 | RDS Multi-AZ — consider for post-go-live (doubles RDS cost) | Tier 3 | 2026-08-31 |
| 20 | CRR to `eu-west-1` — spec called for it; not configured | Tier 3 | 2026-08-31 |
| 21 | Terraform codification of the manually-provisioned AWS infrastructure | Tier 3 | 2026-09-30 |
| 22 | PDF watermarking at delivery time (user email + UTC timestamp) | Product | 2026-05-31 |
| 23 | Replace placeholder logo with final Taranis SVG | Product | 2026-04-30 |
| 24 | **Delete `taranis-dataroom-discovery-readonly` IAM user** once Mark confirms the discovery pass is signed off | Tier 1 | end of this session |

---

## 1. Identity

- **Project name:** Taranis Capital Data Room.
- **Owner entity:** Taranis Capital.
- **Business owner:** Mark Walker (founding partner).
- **State:** **LIVE (beta)** since 8 April 2026. First investor cohort not yet onboarded; admin and a small pilot of internal users exercising the system.
- **Live URL:** <https://dataroom.taraniscapital.com>.
- **Local dev:** `docker-compose up` from the repo root → web on `http://localhost:5173`, api on `http://localhost:3001`.
- **Regulator context:** Dubai Financial Services Authority (DFSA). Key commitments live in code/infra: 8-year `audit_log` retention (append-only by DB trigger), EU data residency (eu-west-2 primary), S3 Object Lock planned (not yet enabled — see §12).

---

## 2. Git

- **Account:** `Walkerma75` — personal GitHub account, **not** an organisation. (The 6 April 2026 decision-log note "existing Taranis org" was aspirational; the actual repo lives under `Walkerma75`. Propagated to `PROJECTS-REGISTER.md` and `ACCOUNTS.md` as part of this discovery pass.)
- **Repo URL:** <https://github.com/Walkerma75/taranis-dataroom>.
- **Visibility:** private.
- **Default branch:** `main`.
- **Live branches on `origin`:**
  - `main` — at `8bec265` (post-scrub). Force-pushed on 2026-04-21 as part of the secret-exposure remediation.
  - `wip/bulk-upload-8-apr` — at `f91d6d2`. Captures the 8 April in-progress bulk-upload + hardening work. Not ready for merge; will need rebase onto the rewritten `main`.
- **No submodules, no Git LFS, no separate vendor repos.**
- **Branch protection:** not configured. `Walkerma75` is a personal account; branch protection on private repos requires GitHub Pro. Logged as follow-up (TASKS.md #17).
- **Push-protection / secret scanning:** state unknown; logged as follow-up (TASKS.md #17).
- **Credential scope:** Mark's laptop. `git config` identity is `Mark Walker <mark@taraniscapital.com>` (per the `91f3d21` commit author). Windows Credential Manager holds the GitHub HTTPS PAT used for `git push`.
- **Working-tree state at start of discovery:** `.git/HEAD.lock` and `.git/index.lock` present (zero-byte, 8 April), cleared on 2026-04-21 before anything else. 14 tracked-modified files, 8 stale `vite.config.js.timestamp-*.mjs` deletions, and several new untracked files (bulk-upload feature mid-build) all captured on `wip/bulk-upload-8-apr`. The working-tree symlink `packages/web/node_modules → /tmp/taranis-web-test/node_modules` is a dangling local-only symlink (gitignored).
- **History-scrub artefacts:** 21 April 2026 `git filter-branch` pass. See `docs/incident/` for the inventory, CloudTrail review, and remediation log. Full pre-scrub tar backup held locally at `../taranis-dataroom.backup-2026-04-21.tar`; removable after Mark's sign-off.

---

## 3. Cloud

### Account and region

- **Account:** `TaranisCapital` (`571600836975`). Same account as the live Taranis Capital static website (migrated separately on 2026-04-20). Discovery discipline: never touch website-owned resources (the `taraniscapital.com` S3 bucket, six CloudFront distributions beginning `E18…`/`E260…`/`E3EJ…`/`E2H8…`/`E98Q…`/`ESMI…`, the five fund-subdomain buckets, or the shared Route 53 zone records other than `dataroom.taraniscapital.com`).
- **Region:** `eu-west-2` (London). The only non-`eu-west-2` resource referenced by the Dataroom is the CloudTrail trail, which is home-region `us-east-1` but multi-region.

### VPC and networking

- **VPC:** `vpc-0b04921984aea3eed`, CIDR `10.0.0.0/16`, default tenancy.
- **Subnets (four, all with `MapPublicIpOnLaunch: false`):**
  - `subnet-091bbf8ae5810c675` — `10.0.0.0/20`, `eu-west-2a`, route table `rtb-04b0a682edca6cb1f` → IGW `igw-07e8f5c7fcd0e5088` (effectively public).
  - `subnet-0e21ba445eb431910` — `10.0.16.0/20`, `eu-west-2b`, same route table → IGW (effectively public).
  - `subnet-0c84e14ad5cd1da9b` — `10.0.128.0/20`, `eu-west-2a`, route table → NAT `nat-1f593927bd94674fc` + S3 VPC endpoint `vpce-0dea89ac7075c3029` (private).
  - `subnet-00168ad1f1cbe07d0` — `10.0.144.0/20`, `eu-west-2b`, same private route table (NAT + VPC endpoint).
- **NAT gateway:** `nat-1f593927bd94674fc` (single, in one public subnet — single point of failure if its AZ is impaired).
- **Internet gateway:** `igw-07e8f5c7fcd0e5088`.
- **S3 VPC endpoint (gateway):** `vpce-0dea89ac7075c3029` — lets the ECS tasks reach S3 without traversing NAT. Cost-efficient and reduces outbound internet surface.
- **Security groups (three, strictly tiered):**
  - `sg-026524a4f66a11284` — `taranis-alb-sg`: inbound TCP 80, 443 from `0.0.0.0/0`.
  - `sg-096263a85fd487bec` — `taranis-ecs-sg`: inbound TCP 80, 4000 from the ALB SG only.
  - `sg-0fbe0581232c887da` — `taranis-rds-sg`: inbound TCP 5432 from the ECS SG only. No public access.

### Load balancer

- **ALB:** `taranis-dataroom-alb`, scheme `internet-facing`, DNS `taranis-dataroom-alb-1500227297.eu-west-2.elb.amazonaws.com`, attached SG `taranis-alb-sg`, in the two public subnets.
- **Listeners:**
  - `HTTP:80` — default action `redirect` to `HTTPS:443` (HTTP 301).
  - `HTTPS:443` — forwards to target group `taranis-dataroom-tg`. SSL policy `ELBSecurityPolicy-2016-08` (outdated — see §12). Certificate `arn:aws:acm:eu-west-2:571600836975:certificate/e8bb602c-8568-4145-aaf6-f9ae962ac58e`.
- **Target group:** `taranis-dataroom-tg`, type IP, protocol HTTP, port 80. Health check `/`, HTTP, healthy threshold 2, unhealthy threshold 3.
- **WAF attachment:** none. Planned in spec, not yet applied — see §12 and TASKS.md #14.

### Compute

- **ECS cluster:** `taranis-dataroom`, Fargate.
- **Service:** `taranis-dataroom-service`. Desired/running count 1/1. Launch type `FARGATE`, platform version `LATEST`. Deployment circuit breaker **disabled** (no auto-rollback on failed deploy). See TASKS.md #16.
- **Task definition family:** `taranis-dataroom`, current revision **`:4`**. Three prior revisions (`:1`, `:2`, `:3`) retained for rollback.
- **Task definition revision 4:**
  - CPU 1 vCPU / memory 2048 MB.
  - Task role: `arn:aws:iam::571600836975:role/taranis-dataroom-task-role`.
  - Execution role: `arn:aws:iam::571600836975:role/ecsTaskExecutionRole` (AWS default).
  - Network mode: `awsvpc`.
  - **Container `api`:** image `571600836975.dkr.ecr.eu-west-2.amazonaws.com/taranis-dataroom/api:latest`, port 4000 → 4000, 12 plaintext environment variables: `NODE_ENV`, `API_PORT`, `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `PGSSLMODE`, `NODE_TLS_REJECT_UNAUTHORIZED`, `JWT_SECRET`, `S3_BUCKET`, `AWS_REGION`. **Zero `secrets:` block entries** — no Secrets Manager references today. This is the Tier 1 follow-up (TASKS.md #5).
  - **Container `web`:** image `571600836975.dkr.ecr.eu-west-2.amazonaws.com/taranis-dataroom/web:latest`, port 80 → 80, no environment variables (baked into build at image-build time via `VITE_API_URL=/api`).

### Container registry

- **Repos:** `taranis-dataroom/api` + `taranis-dataroom/web`.
- **Scan on push:** **enabled** on both.
- **Tag mutability:** `MUTABLE` on both. The only surfaced tag is `:latest` on both repos — no SHA-based tags. ECR scan results on both repos show `scanStatus: null` (scans appear not to have completed on the pushed `:latest` images — investigate).
- **Encryption:** `AES256` at rest (default, on both).

### Storage

- **S3 bucket:** `taranis-dataroom-documents-prod`, region `eu-west-2`.
  - **Versioning:** Enabled.
  - **Default encryption:** SSE-S3 (`AES256`), `BucketKeyEnabled: false`.
  - **Public access block:** all four flags **ON** (BlockPublicAcls, IgnorePublicAcls, BlockPublicPolicy, RestrictPublicBuckets).
  - **Object Lock:** **NOT CONFIGURED**. This is the DFSA-retention gap — see §12 and TASKS.md #1.
  - **Bucket policy:** none (no bucket policy set). Access is governed exclusively by IAM role policies.
  - **Lifecycle rules:** none.
  - **Access logging:** none.
  - **Replication (CRR):** none. Spec called for `CRR to eu-west-1`; not configured.

### DNS and certificates

- **Hosted zone:** `/hostedzone/Z0680053Y587NB8B8C9S`, `taraniscapital.com.`, public, 16 records (shared with the website).
- **Record for Dataroom:** `dataroom.taraniscapital.com.` — A-record **ALIAS** to the ALB (`taranis-dataroom-alb-1500227297.eu-west-2.elb.amazonaws.com.`, alias zone `ZHURV8PSTC4K8`, `EvaluateTargetHealth: true`). Plus the ACM DNS-validation CNAME `_4e9c0106bf0bbe7ff6451b774be39d41.dataroom.taraniscapital.com.`.
- **ACM certificate (ALB, `eu-west-2`):** `arn:aws:acm:eu-west-2:571600836975:certificate/e8bb602c-8568-4145-aaf6-f9ae962ac58e`, domain `dataroom.taraniscapital.com`, issuer Amazon, issued 2026-04-08, **expires 2026-10-23**, `RenewalEligibility: ELIGIBLE`, RSA-2048, DNS-validated. Should renew automatically in mid-to-late August.
- **ACM certificates in `us-east-1`:** `taraniscapital.com` and `*.taraniscapital.com` — these belong to the website's CloudFront distributions, **not** the Dataroom. The Dataroom has no CloudFront distribution.
- **CloudFront:** no Dataroom distribution exists. (The CLAUDE-level gotcha about "CloudFront OAC 5-min TTL presigned URLs" was a spec plan; implementation instead proxies S3 downloads through the ECS API via the task role.) The six CloudFront distributions in the account are the website's.

### IAM

- **IAM users in the account (four + our readonly):**
  - `github-deploy` (created 2026-04-02) — the website's original CI user. Attached policies: `AmazonS3FullAccess`, `CloudFrontFullAccess`. Access keys: one Active (`AKIA…QLJPZRXC`) + one Inactive (`AKIA…YJKO36XV`). Not the Dataroom's deploy principal — listed for completeness since ACCOUNTS.md labels the Dataroom as sharing this account.
  - `taranis-deploy` (created 2026-04-08) — the Dataroom's original deploy user. **Access key deactivated** (`AKIA…EE4G`, Inactive). Attached managed policies: `AmazonRoute53FullAccess`, `CloudFrontFullAccess`, `AmazonS3FullAccess`, `AmazonEC2ContainerRegistryPowerUser`. Inline policy `ECSDeployPolicy` grants `ecs:*` (actions listed below) + `iam:PassRole` + `logs:*` on `Resource: "*"`. **Substantially over-permissive across the whole account; both AWS keys on this user are dead.** To be replaced by a least-privilege `taranis-dataroom-deploy`, TASKS.md #4.
  - `taranis-website-deploy` (created 2026-04-20) — the website's new deploy user. Out of scope for the Dataroom.
  - `taranis-dataroom-discovery-readonly` (created 2026-04-21) — temp user created by Mark for this discovery pass. `ReadOnlyAccess` managed policy. Key `AKIA…FKP2`. **Delete after Mark's sign-off** (TASKS.md #24).
- **Task role `taranis-dataroom-task-role` (used by the running Fargate task):**
  - Attached policy: customer-managed `taranis-dataroom-s3-access` (JSON below).
  - No inline policies.
  - **Policy JSON:**
    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::taranis-dataroom-documents-prod/*" },
        { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::taranis-dataroom-documents-prod" }
      ]
    }
    ```
  - Correctly scoped. Could be tightened further by removing `s3:DeleteObject` (the app uses archive-status soft-delete rather than hard deletion), but that's a minor hardening item, not a blocker.
- **Execution role `ecsTaskExecutionRole`:** AWS default. Would need `secretsmanager:GetSecretValue` + `kms:Decrypt` attached to it once Secrets Manager is wired up.
- **Root account:** MFA status not visible with `ReadOnlyAccess`. Mark's responsibility to confirm; assume on per the website migration baseline.

### CloudTrail

- **Trail:** `taranis-capital-account-trail`, multi-region, home region `us-east-1`, started logging 2026-04-20 16:30 UTC (the day of the website migration). `LogFileValidationEnabled: true`. Logs delivered to `aws-cloudtrail-logs-571600836975-f495d2a6`.
- **Event selectors:** Management events only (via `AdvancedEventSelectors`). No S3 data events, no Lambda data events. Enabling S3 data events for the Dataroom documents bucket is a deferred inline fix (TASKS.md #9).
- **KMS:** not encrypted (trail log file integrity is covered by `LogFileValidationEnabled: true`).

### Other AWS services

- **CloudWatch log groups (Dataroom):** `/ecs/taranis-dataroom` — 11.9 MB stored, **retention: never-expire** (cost risk, see §12 and TASKS.md #11). No `/aws/rds/*` log groups — RDS query logging not enabled.
- **CloudWatch alarms:** **none** for any Dataroom resource. TASKS.md #10.
- **Secrets Manager:** **empty** for Dataroom. No secrets exist today — everything is in plaintext task-definition env vars (see §4).
- **WAF:** no Web ACL attached to the Dataroom ALB. Website's main CloudFront distribution has a WAF, but it's us-east-1 / CloudFront scope — doesn't protect the Dataroom.
- **GuardDuty / Trusted Advisor / Security Hub / Config:** not inspected — `ReadOnlyAccess` limitations on some and out of scope for discovery. Questions for Mark.

---

## 4. Secrets

Complete enumeration of every secret the Dataroom needs. Names and locations only — no values. See `docs/incident/secrets-inventory.md` for the 8 April 2026 exposure record (closed) and `docs/incident/README.md` for the remediation trail.

| Secret | What it is | **Where it lives TODAY** | Rotation schedule | Who has access |
|---|---|---|---|---|
| RDS master password | PostgreSQL password for DB user `taranis` | **AWS Secrets Manager:** `taranis-dataroom/rds/master-33xQ2s` (JSON body with `username` + `password` keys). Referenced from ECS task-def `:6` via `secrets:` block with `:password::` JSON-key selector. Value rotated 2026-04-22; RDS server password modified in the same window. | Quarterly manual rotation on calendar (option for automatic via Secrets Manager rotation Lambda deferred — TASKS.md backlog) | `ecsTaskExecutionRole` via scoped inline policy `taranis-dataroom-secrets-access`; Mark via AWS Console |
| JWT signing secret | HMAC secret for access+refresh JWTs (15-min access, opaque refresh) | **AWS Secrets Manager:** `taranis-dataroom/jwt/signing-616MGX` (plaintext value). Referenced from ECS task-def `:6` via `secrets:` block. Value rotated 2026-04-22 — invalidated all live sessions at rotation time (expected, no user impact pre-go-live). | Annual or on-breach | Same as RDS row |
| Seed admin password (`SEED_ADMIN_PASSWORD`) | Bootstraps the initial admin user on a blank DB; app refuses to boot if absent and no admin exists | **AWS Secrets Manager:** `taranis-dataroom/seed/admin-6Wa82t` (plaintext value). **Deliberately NOT referenced** from the running task definition — pre-positioned for DR restore-from-blank-DB scenarios only. Exec role's inline policy lists only `rds/master` and `jwt/signing`, so running tasks cannot read this secret. | N/A (one-shot at bootstrap in DR scenarios) | Mark via Console only |
| Amazon SES SMTP credentials | Invite + MFA-code + broadcast-notice emails | Not yet wired. SES integration deferred until SES production access is confirmed. | Annual | Mark once created |
| SMS MFA provider credentials | SMS fallback for MFA codes | Not wired. Provider not decided (Twilio / SNS SMS / AWS End User Messaging SMS). | Annual | Mark once created |
| RDS TLS certificate bundle | For verifying the RDS server cert when `PGSSLMODE=verify-full` | Not required today. `PGSSLMODE=require` (encrypt, do not verify cert). App's `packages/api/src/db.js` configures `ssl: { rejectUnauthorized: false }` gated on `PGSSLMODE`, matching the prior effective posture but scoped to the one Postgres connection rather than a global `NODE_TLS_REJECT_UNAUTHORIZED=0`. Upgrade to `verify-full` paired with TASKS.md #13 (requires bundling RDS CA chain in the image). | N/A | N/A |

**Known historical exposure (closed):** the 8 April 2026 commit of `DEPLOY_NOW.md` to the public `Walkerma75/taranis-dataroom` repo leaked an AWS access key (`AKIA…OP7D`), its secret, the RDS master password at the time, and the default admin password `Admin123!`. Both AWS keys on the `taranis-deploy` user are now deactivated; the user itself was deleted 2026-04-22 as part of the Phase 1 hardening. The admin password was rotated in-app on 2026-04-21. **The RDS master password was rotated 2026-04-22** via the atomic Secrets-Manager-plus-RDS-Modify sequence; the JWT signing secret was folded into the same rotation window because it had been plaintext in the ECS task definition for the full window since 8 April. Git history was scrubbed on 2026-04-21 via `git filter-branch`; zero post-scrub hits verified. CloudTrail review (`docs/incident/cloudtrail-akia-OP7D.json`) returned zero events across the full 90-day Event-history window — key appears never to have been used.

**`.env` on disk (local-dev only):** the repo root contains a `.env` file (properly gitignored, never committed) that carries Mark's local-dev values. Not an exposure surface.

**Access control after 2026-04-22:** the ECS task definition `:6` no longer contains any plaintext secret values. `ecs:DescribeTaskDefinition` on the account now reveals only ARNs, not values. Retrieving the actual secret values requires `secretsmanager:GetSecretValue` on the specific secret ARN — which the inline policy `taranis-dataroom-secrets-access` grants to `ecsTaskExecutionRole` for only `rds/master` and `jwt/signing` (not `seed/admin`). Same-account KMS decrypt is granted transparently via the default `aws/secretsmanager` key policy, so no explicit KMS grant was required.

---

## 5. CI / CD

- **Pipeline file:** `.github/workflows/deploy.yml`.
- **Trigger:** `push: branches: [main]` + `workflow_dispatch`.
- **Actions used:** `actions/checkout@v4`, `aws-actions/configure-aws-credentials@v4`, `aws-actions/amazon-ecr-login@v2`, `aws-actions/amazon-ecs-render-task-definition@v1`, `aws-actions/amazon-ecs-deploy-task-definition@v2`.
- **Credentials:** references `${{ secrets.AWS_ACCOUNT_ID }}`, `${{ secrets.AWS_ACCESS_KEY_ID }}`, `${{ secrets.AWS_SECRET_ACCESS_KEY }}`. These repo-level secrets currently hold the **dead** `taranis-deploy` key — every workflow run fails at the "Configure AWS credentials" step until the new `taranis-dataroom-deploy` user is created and the secrets updated.
- **Images tagged:** `:latest` + `:${{ github.sha }}`.
- **Deploy method:** `aws-actions/amazon-ecs-deploy-task-definition@v2` with `wait-for-service-stability: true`.
- **Rollback procedure (not yet drilled):**
  ```bash
  # Fargate preserves prior task-definition revisions; revert by pinning the service
  # back to a known-good revision and forcing a new deployment.
  aws ecs update-service \
    --cluster taranis-dataroom \
    --service taranis-dataroom-service \
    --task-definition taranis-dataroom:<PRIOR_REV> \
    --force-new-deployment \
    --region eu-west-2
  # Watch
  aws ecs describe-services \
    --cluster taranis-dataroom \
    --services taranis-dataroom-service \
    --query "services[0].deployments" \
    --region eu-west-2
  ```
  **Caveat:** because images are tagged `:latest` (mutable), "revert to task-definition :3" will still pull today's `:latest` image, not the image that was running when `:3` was the active revision. Deterministic rollback requires unique image tags per build (TASKS.md #15). For now, rollback = revert the task-def revision AND re-push the prior image's bytes to `:latest`.
- **Operational deploy today:** `deploy.bat` from PowerShell on Mark's laptop. Logs into ECR, builds api + web images, pushes `:latest`, runs `aws ecs update-service --force-new-deployment`. Bus-factor-of-one (Question for Mark #8).
- **Approvers:** Mark, alone.

---

## 6. DNS

- **Hostname:** `dataroom.taraniscapital.com`.
- **Registrar:** e& (nic.ae) — the parent domain `taraniscapital.com` was migrated away from Funkygrafix on 7 April 2026.
- **DNS provider:** Route 53 — hosted zone `Z0680053Y587NB8B8C9S` in account `571600836975`.
- **Record:** A-record ALIAS to ALB `taranis-dataroom-alb-1500227297.eu-west-2.elb.amazonaws.com.` + the ACM validation CNAME.
- **Certificate issuer:** Amazon (ACM public).
- **Certificate expiry:** 2026-10-23 (auto-renew eligible).
- **DNSSEC:** not inspected — state unknown. Tier 3 consideration for later.

---

## 7. Third-party integrations

Every external service the app talks to today:

| Service | Purpose | Where credential lives | Contract / billing |
|---|---|---|---|
| **Amazon SES** | Invite emails, MFA codes, broadcast notices | **Not yet wired.** Blocked on SES production-access (Question for Mark #7). | AWS billing |
| **SMS MFA provider** | MFA SMS fallback | **Not yet wired.** Provider choice TBD (Twilio / SNS / End User Messaging). | TBD |
| **`@react-pdf-viewer/*`** | In-browser PDF rendering on the documents page | NPM package, bundled at build time. No runtime API calls, no phone-home beacons. | MIT / Apache licence, free |
| **Google Fonts** | Playfair Display + Inter | CDN at render time (no credential). | Free |
| **GitHub Actions** | CI/CD (dead today, see §5) | Repo secrets | Free tier on personal account |
| **GitHub** | Source hosting | SSH key or HTTPS PAT in Windows Credential Manager on Mark's laptop | Free tier |

No analytics / monitoring / Sentry / RUM tooling embedded in the React app or the API middleware. No Cloudflare / Akamai / other CDN in front of the ALB.

---

## 8. Database

Database is a **full** section for Tier 3 — regulated, audit-trigger-protected, production-critical.

### Engine and connection

- **Engine:** PostgreSQL 16.10 on RDS (Amazon-managed). `auto_minor_version_upgrade: true` — patches apply during the maintenance window.
- **Instance:** `taranis-dataroom`, class `db.t3.micro`, storage `20 GB gp3`, single-AZ (`eu-west-2b`).
- **Endpoint:** `taranis-dataroom.ctkmi66yk82u.eu-west-2.rds.amazonaws.com:5432`.
- **Master user:** `taranis` (the application connects directly as this user today — it is **also the master user**, which means the app could `DROP TABLE audit_log` if compromised; a separate application role is a hardening item, not currently in place).
- **Public access:** false.
- **Database name:** `dataroom`.
- **Parameter group:** `taranis-dataroom-pg16` (customer-managed).
  - `ssl = 1` (server supports TLS).
  - **`rds.force_ssl = 0`** — clients are **NOT required** to use TLS. App-side `PGSSLMODE` enforcement is therefore the only layer forcing TLS today. Flip to `1` pending reboot (TASKS.md #13).
  - `shared_preload_libraries = pg_stat_statements,pg_tle`.
  - Query logging (`log_connections`, `log_disconnections`, `log_statement`, `log_min_duration_statement`) all at engine defaults — not actively logging to CloudWatch today.
- **Encryption at rest:** **NOT encrypted.** `storageEncrypted: false`, `kmsKeyId: null`. DFSA compliance improvement — TASKS.md #8.
- **Deletion protection:** **OFF** — TASKS.md #13.
- **Performance Insights:** disabled.
- **Multi-AZ:** disabled — TASKS.md #19.

### Schema and migrations

- **Migration tool:** custom `packages/api/src/db/migrate.js` (plus startup-time `autoMigrate()` in `packages/api/src/index.js` which applies pending `.sql` files in order and tracks them in a `_migrations` table).
- **Head migration:** `008_password_resets.sql`.
- **Full migration list:**
  1. `001_users_and_auth.sql` — users, MFA secrets, refresh tokens, invites.
  2. `002_funds_and_documents.sql` — funds, document_categories (seeded nine at creation — Overview, PPM, LPA, Subscription Docs, Financials, Technical, Legal, Correspondence, Pitch Deck), documents.
  3. `003_permissions.sql` — grants (user × fund × category), per-document overrides, permission templates.
  4. `004_audit_log.sql` — append-only `audit_log` table with UPDATE/DELETE blocked at trigger level (DFSA). **Never modify.**
  5. `005_notices.sql` — broadcast notices + recipient tracking.
  6. `006_rename_categories.sql` — rename PPM → Private Placement Memorandum, LPA → Legal Documents (merging old Legal + Subscription Docs), Pitch Deck → Pitch Deck / Presentation. Final seven categories today.
  7. `007_capabilities_and_merge_roles.sql` — per-user `capabilities` JSONB column; Consultant role merged into Advisor; four roles post-migration (Admin, Investor, Advisor, Viewer).
  8. `008_password_resets.sql` — password-reset-token table.
- **Seed:** `packages/api/src/db/seed.js` — admin user only, requires `SEED_ADMIN_PASSWORD` env var, never overwrites an existing admin (`ON CONFLICT DO NOTHING`). No funds, no document categories (those come from migration 002). Rewritten on 2026-04-21 as part of the secret-exposure remediation.

### Backups

- **Automated backups:** 7-day retention, window 00:02–00:32 UTC daily. Backups are unencrypted (follows storage encryption, which is off).
- **Snapshot history visible:** seven automated snapshots from 2026-04-14 onwards.
- **Manual snapshots:** none.
- **Last tested restore:** **never.** TASKS.md #2.
- **Point-in-time recovery:** available within the 7-day retention window.

### Application connection

- **Role for the app:** same as master (`taranis`). Hardening follow-up: split into a writer role that cannot `DROP`, and use that from the app.
- **Audit trigger protection:** UPDATE and DELETE on `audit_log` are blocked by triggers created in migration 004 — attempts raise a PL/pgSQL exception. Verified present in the migration source; not reading the live `pg_trigger` from `ReadOnlyAccess` (no RDS-Data access).

---

## 9. Monitoring / alerting

- **Tooling:** CloudWatch only.
- **Log groups:**
  - `/ecs/taranis-dataroom` — ECS task stdout/stderr, 11.9 MB retained, **no retention policy** (never expires). TASKS.md #11.
  - No `/aws/rds/*` log groups — RDS not exporting to CloudWatch.
  - No ALB access log group (ALB access logs to S3 not configured either).
- **Metric filters:** none.
- **Alarms:** **none** for any Dataroom resource. TASKS.md #10.
- **SNS topic:** none for Dataroom. TASKS.md #10 includes creating one emailing `mark@taraniscapital.com`.
- **Dashboards:** none.
- **Paging:** none — Mark would learn about an outage from a user complaint or from the CloudFormation-free infra just not responding.
- **Uptime monitoring:** none. (The Taranis Capital Website uses UptimeRobot with a public stats page — the Dataroom has no equivalent.)
- **Anti-drift:** `deploy.bat` prints the running-count from the ECS service after each deploy. That's the only automated post-deploy check.

---

## 10. Backup / DR

### Current backup posture

- **RDS:** 7-day automated backups + PITR, unencrypted. No manual snapshots before deploys.
- **S3 documents bucket:** versioning enabled; Object Lock **not** enabled; no CRR; no access logs.
- **ECR:** image retention default (no lifecycle); all historical `:latest`-tagged digests still in the repos.
- **Secrets Manager:** no secrets today; when created, AWS auto-replicates secret metadata within region but CRR is a separate setting per secret.
- **ECS task definitions:** four revisions retained on the family (`:1`–`:4`).

### Restore-from-nothing procedure

Target: bring the Dataroom back from "everything in the AWS account except the RDS snapshots and the S3 documents bucket has been deleted". Today's first-principles time estimate: **4–8 hours**, because the infrastructure is still manually provisioned (Terraform codification is TASKS.md #21).

1. **Pre-requisites to have available off-account:** this inventory (for resource names / IDs), the tar backup of the repo (or a fresh clone from GitHub), a working AWS credential with deploy-level permissions, Docker Desktop, and a working laptop.
2. **VPC + subnets + SGs + IGW + NAT + VPC endpoint:** recreate per §3 — `10.0.0.0/16` CIDR, four subnets as listed, three SGs in the tiered pattern (ALB → ECS → RDS), gateway VPC endpoint for S3.
3. **RDS restore:** `aws rds restore-db-instance-from-db-snapshot --db-instance-identifier taranis-dataroom --db-snapshot-identifier <most-recent-snap>` into the new private subnets with the new `taranis-rds-sg`.
4. **S3 documents bucket:** if the bucket itself is gone, re-create `taranis-dataroom-documents-prod` and restore from the eu-west-1 CRR replica (once CRR exists — TASKS.md #20). If no CRR, files for objects written before the last restore point are lost; versioning would only have helped against deletion, not total bucket loss.
5. **ECR:** push the Docker images from a working local Docker build (or from another region's ECR replica if set up). Current images are ~52 MB (api) + ~27 MB (web).
6. **IAM:** recreate `taranis-dataroom-task-role` (S3 policy attached) and the new `taranis-dataroom-deploy` IAM user.
7. **Secrets Manager:** recreate the DB password and JWT signing secrets.
8. **ACM certificate:** re-request via DNS validation — the shared Route 53 zone survives unless the whole account is gone.
9. **ALB + listeners + target group.**
10. **ECS cluster, task definition (referencing the Secrets Manager entries and the new S3 bucket), service.**
11. **Route 53:** re-point `dataroom.taraniscapital.com` ALIAS to the new ALB.
12. **Smoke-test:** hit `https://dataroom.taraniscapital.com`, log in as the admin (password from `SEED_ADMIN_PASSWORD` if the admin user was lost with the DB), upload one document, download one document, confirm the audit log has both entries.

### Drills

- **Last restore drill:** never run. Scheduled in TASKS.md #2 with deadline 2026-05-31.
- **Last rollback drill:** never run. Scheduled in TASKS.md #3 with deadline 2026-05-31.
- Tier 3 difference from the Tier 2 briefs: drills are **not** run inline during discovery. Rolling a live Fargate service back to a prior revision on a regulated-production app is not a low-risk action to rehearse without a scheduled window.

---

## 11. Tribal knowledge

Things that only live in Mark's head (or in scattered chat / spec notes), captured here so the next engineer doesn't have to re-derive them:

- **Taranis Capital, not Pro-curo.** The product spec v1.0 references "alignment with Pro-curo V5 stack" in multiple places; this is wrong and disregarded. The Dataroom is a standalone Taranis Capital product.
- **Three-dimensional access model (user × fund × category).** Role determines what a user can *do*; grants determine what they can *see*. Permission templates are convenience; they always resolve to explicit per-user grants. Any grant change writes to `audit_log`.
- **Consultant merged into Advisor** (migration 007) — the spec has five roles (Admin/Investor/Advisor/Consultant/Viewer), the build has four. Existing consultants were migrated to Advisor.
- **Audit trigger at DB level, not app level.** Defence in depth: a compromised app service cannot lose audit trail, because the DB itself blocks `UPDATE` / `DELETE` on `audit_log` via triggers.
- **S3 pattern: bytes in S3, metadata in Postgres, always.** Upload via Multer → tempfile → `PutObject` (SSE-S3 at rest) → metadata row in Postgres → delete tempfile. Download: stream `GetObject` body directly to the HTTP response with auth + audit-write upfront. Deliberately no app-layer encryption — keeps the file inspectable by ClamAV / previewers / digital-signature readers without decrypt/re-encrypt. See `../Dataroom_Document_Handling_Approach.md` for the portable write-up.
- **`deploy.bat` historically pinned `AWS_PROFILE=TaranisCapital` explicitly** to stop an accidental `default` or `disruptsmedia` profile from deploying to the wrong account. That line was added in the 8 April WIP work and will return when `wip/bulk-upload-8-apr` is merged back.
- **Build number `DR-0.1.0-b{YYYYMMDD.HHMM}` shown at the bottom of the sidebar** — the spec/notes reference this as the image tag convention, but in practice `deploy.bat` uses `:latest`. Mismatch.
- **Password rotation in prod is done in-app (Change Password screen),** not at the DB level. The admin was rotated in-app on 2026-04-21 — the seed script's `ON CONFLICT DO NOTHING` guarantees no deploy overwrites it afterwards.
- **Why the initial admin in seed is "Mark Walker" by display name.** Audit-log rows attribute actions to the user's `display_name`. Keeping Mark's name preserves audit continuity post-scrub. Rename via the UI (not in code) if the admin ever transfers to another person.
- **RDS instance ID `taranis-dataroom.ctkmi66yk82u…`** — note the `ctkmi`, not `ctkml` as `DEPLOY_NOW.md` claimed. The deleted cheatsheet had a typo.
- **The 8 April 2026 secret exposure (closed).** See `docs/incident/README.md` for the full incident write-up, CloudTrail review, and remediation checklist. Key lesson: the 8 April push bundled a "cheatsheet" with live keys into the committed tree.

---

## 12. Known risks / open items

Live risks, in rough order of severity. Every item has a TASKS.md ticket.

- **Object Lock is OFF on `taranis-dataroom-documents-prod`** — DFSA retention gap. Object Lock is irreversible once enabled, so the fix requires an explicit decision on retention mode (Compliance vs Governance) and retention window (presumably 8 years to match the audit-log commitment). TASKS.md #1, Tier 1, deadline 2026-05-15.
- **RDS storage not encrypted at rest.** `storageEncrypted: false`, `kmsKeyId: null` — all seven visible snapshots likewise unencrypted. Fixing requires snapshot → restore to an encrypted instance → cutover. TASKS.md #8, Tier 2.
- **RDS `rds.force_ssl = 0`.** TLS to the DB is enforceable only from the app side (`PGSSLMODE`), not from the server. One mis-set env var could open cleartext connections in-VPC. TASKS.md #13, Tier 2.
- **No restore or rollback drill has ever been run.** Tier 3 hallmark risk. TASKS.md #2, #3, both Tier 1, deadline 2026-05-31.
- **ALB SSL policy `ELBSecurityPolicy-2016-08`.** Allows TLS 1.0/1.1. Spec called for "TLS 1.3 only". TASKS.md #12, Tier 2.
- **No WAF on the ALB.** Spec called for rate-limiting + OWASP. TASKS.md #14, Tier 2.
- **Zero CloudWatch alarms.** No visibility into ALB 5xx, ECS unhealthy tasks, RDS CPU, Secrets Manager rotation failures. TASKS.md #10.
- **`/ecs/taranis-dataroom` log group has no retention.** Cost creep. TASKS.md #11.
- **Image tags all `:latest` on `deploy.bat`**; task definition reverting doesn't give deterministic rollback. CI workflow already tags with both `:latest` and `:${{ github.sha }}`, so CI deploys do have a unique-tag path — deploy.bat does not. TASKS.md #15.
- **ECS deployment circuit breaker disabled** — a failed deploy will keep replacing healthy tasks with broken ones. Felt this directly during the 2026-04-22 rotation where multiple `:5` task-def boot attempts failed silently (exit code 1 on essential container) and ECS kept trying. TASKS.md #16.
- **SES production-access status unknown on `TaranisCapital` account.** Blocks invite/MFA/broadcast emails when SES is finally wired. Question for Mark #7, TASKS.md #7.
- **No CRR from `eu-west-2` to `eu-west-1`.** Spec called for it. TASKS.md #20.
- **Single-AZ RDS.** One AZ impairment = ~30-minute Dataroom outage. TASKS.md #19.
- **NAT gateway is single-AZ too.** An `eu-west-2a` AZ outage kills outbound internet for both private-subnet ranges even though the second private subnet is in `eu-west-2b` — because both private route tables point at the same NAT. Same-line consideration as RDS Multi-AZ.
- **ECR image scanning result state `null`** — scans appear not to have completed on the current images despite `scanOnPush: true`. No CVE visibility.
- **No pre-commit secret scanning** (e.g. `gitleaks`, `detect-secrets`). Would have caught the 8 April exposure. TASKS.md #17 covers the GitHub-side protection; a pre-commit hook is a worthwhile hardening.
- **`deploy.bat` is Windows-only.** Any future co-owner on macOS / Linux would need a portable equivalent. CI via GitHub Actions is now the portable path (wired 2026-04-22).
- **Product spec references "Pro-curo V5 stack alignment"** — deliberately ignored per the 6 April decision log; noted here so future readers don't accidentally re-introduce shared dependencies.
- **PDF watermarking** (user email + UTC timestamp stamped into the PDF at delivery time) — spec requirement, not implemented. Product-level TASKS.md #22.
- **Placeholder logo still in the React bundle.** TASKS.md #23.

### Resolved 2026-04-22

The Tier 3 discovery-follow-up work completed this date closed out five of the original §12 risks plus surfaced and fixed three latent bugs that had been masked by the old configuration.

- **~~All secrets in plaintext on the ECS task definition~~** → moved to Secrets Manager (`rds/master`, `jwt/signing`, `seed/admin`), task-def `:6` references them via `secrets:` block. Plaintext env vars for `POSTGRES_PASSWORD` and `JWT_SECRET` gone. TASKS.md #5 closed.
- **~~RDS master password exposure from 8 April leak~~** → password rotated 2026-04-22 via the atomic Secrets-Manager-plus-RDS-Modify sequence. TASKS.md #6 closed. Quarterly rotation reminder on calendar.
- **~~JWT signing secret plaintext in task def since 8 April~~** → rotated in the same window (folded into #5/#6). All live sessions invalidated at rotation time; no user impact pre-go-live.
- **~~`taranis-deploy` IAM policy dangerously broad~~** → user deleted 2026-04-22. Replaced with `taranis-dataroom-deploy` user carrying a least-privilege policy scoped to the Dataroom's ECR repos, ECS cluster/service, and `iam:PassRole` on the two ECS roles. No S3 in the policy (deploy flow never touches S3 — runtime does, via the task role). TASKS.md #4 closed.
- **~~`NODE_TLS_REJECT_UNAUTHORIZED`=0 globally disabling TLS verification~~** → env var removed entirely from task-def `:5`/`:6`. Replaced with explicit `ssl: { rejectUnauthorized: false }` in `packages/api/src/db.js` scoped to the Postgres connection only.
- **~~Deployment bus-factor of one~~** → CI auto-deploy on push to `main` now active. `deploy.bat` retained as a fallback, pinned to `AWS_PROFILE=TaranisCapital`.

Three **latent bugs** were exposed during the rotation (all documented as Tier 3 pre-flight checks in `../WORKFLOW.md` → Latent bugs exposed during Tier 3 migrations):

- **pg.Pool had no explicit `ssl:` config** — connectivity worked in prod because `NODE_TLS_REJECT_UNAUTHORIZED=0` bypassed Node's TLS validator globally. Removing that env var (correctly) exposed `self-signed certificate in certificate chain` against the RDS cert. Fixed in `packages/api/src/db.js` commit `5bdd877`.
- **Per-package Dockerfiles used `npm ci` without a workspace lockfile** — monorepo uses npm workspaces with the authoritative `package-lock.json` at the repo root; `packages/api` and `packages/web` carry no lockfile of their own. `npm ci` fails on a fresh CI build because the optional `package-lock.json*` glob silently passes the copy step. Fixed in both Dockerfiles by switching to `npm install`. Proper fix (build from repo-root context) deferred to TASKS.md backlog.
- **Frontend API base URL defaulted to `http://localhost:4000`** in four `packages/web/src/` files — since Vite bakes env vars at build time (not runtime), any build that didn't pass `VITE_API_URL` shipped with the absolute localhost URL baked into the bundle. Users with cached JWTs in `localStorage` never exercised the login form, so the bug was invisible. JWT rotation forced a fresh login and exposed it. Fixed by defaulting to relative `/api` (which nginx in the web container proxies to the api container in prod, and `vite.config.js` dev proxy handles in local dev). Commit `e1e68db`.

---

## Appendix A — Inline rollback CLI (for the scheduled drill)

```bash
# Confirm current revision
aws ecs describe-services \
  --cluster taranis-dataroom \
  --services taranis-dataroom-service \
  --query "services[0].taskDefinition" \
  --region eu-west-2

# Roll back to revision N (verify task-def N matches the currently-running image digests first)
aws ecs update-service \
  --cluster taranis-dataroom \
  --service taranis-dataroom-service \
  --task-definition taranis-dataroom:3 \
  --force-new-deployment \
  --region eu-west-2

# Watch deployment progress
aws ecs describe-services \
  --cluster taranis-dataroom \
  --services taranis-dataroom-service \
  --query "services[0].deployments" \
  --region eu-west-2

# If deployment wedges, halt it
aws ecs update-service \
  --cluster taranis-dataroom \
  --service taranis-dataroom-service \
  --desired-count 0 \
  --region eu-west-2
```

Caveat: images tagged `:latest` mean the "revert to revision N" result is "revision N's env vars + today's `:latest` image bytes", not a byte-identical rollback. See TASKS.md #15 for the unique-tag fix.

---

## Appendix B — Atomic RDS-rotation + Secrets-Manager ordering

**Corrected 2026-04-22 after executing this sequence in production.** The original version of this appendix had a logical error — step 1 said "fresh random password" but step 4 claimed the Secrets Manager value still equalled the current RDS password. Those are incompatible, and rolling the new task-def to production while Secrets Manager held a value that didn't match RDS would have caused immediate auth failure on new tasks. The corrected sequence below is what actually works.

### The correct sequence

1. **Create the Secrets Manager secrets** — three in our case: `taranis-dataroom/rds/master` (JSON `{"username":"taranis","password":"…"}`), `taranis-dataroom/jwt/signing` (plaintext), `taranis-dataroom/seed/admin` (plaintext, DR pre-position). KMS encrypted under the AWS-managed `aws/secretsmanager` key (same-account principals get `kms:Decrypt` via default key policy — no explicit KMS grant needed).
2. **Populate `rds/master` with the CURRENT RDS password**, not a new random value. This makes step 4's service roll a no-op as far as DB credentials are concerned — new tasks fetch from Secrets Manager instead of env, but the value is the same as the plaintext they were using before. If you seed with a new value here, the roll breaks.
3. **Grant the ECS execution role `secretsmanager:GetSecretValue`** on the specific secret ARNs (runtime-referenced only — `rds/master` and `jwt/signing`, not `seed/admin`) via an inline policy. Scope to ARNs explicitly; do not wildcard `taranis-dataroom/*`.
4. **Register a new ECS task-definition revision** that replaces the plaintext `POSTGRES_PASSWORD`, `JWT_SECRET`, and `NODE_TLS_REJECT_UNAUTHORIZED` env vars. Add a `secrets:` block referencing the two runtime ARNs (`rds/master` with `:password::` JSON-key selector, `jwt/signing` plain).
5. **`update-service` to the new revision, `force-new-deployment`, wait for stability.** Tasks now read the CURRENT RDS password from Secrets Manager. Service stays healthy. **FREEZE WINDOW OPENS HERE** — no other deploys, no pushes to `main` (if CI auto-deploys on push).
6. **Overwrite `rds/master` with a NEW random password.** Running tasks don't notice — their env var was populated at startup and doesn't re-read. Existing connections continue to work (Postgres authenticates at connect time, not per query).
7. **Rotate the RDS master password to the SAME new value** via `aws rds modify-db-instance --master-user-password <new> --apply-immediately` (or RDS Console → Modify → Credentials settings → Self managed). **DO NOT** omit `--apply-immediately` or the rotation queues for the maintenance window. At this point existing Postgres connections from running tasks continue to work; any NEW connection attempts fail (they'd use the old cached env value against the rotated server).
8. **`force-new-deployment` again** so fresh tasks boot, fetch the NEW password from Secrets Manager, and authenticate cleanly against the rotated RDS. Existing stale-cached tasks drain as the new ones come up healthy. Brief ~30s window where some in-pool reconnections fail — acceptable pre-go-live, minimal post-go-live (matters more if the app is chatty).
9. **FREEZE WINDOW CLOSES.** Normal deploys resume.

### What this looks like in total calendar time

- Steps 1-4: discovery/prep, as much time as you need. Do them at desk, not in the rotation window.
- Steps 5-9: single contiguous ~10-15 minute window. Don't stretch it.

### Cross-rotating the JWT signing secret in the same window

If the JWT secret has been plaintext in the task definition since deployment, it has the same exposure surface as the RDS password (anyone with `ecs:DescribeTaskDefinition` can read it). Rotate it in the same window:

- Secrets Manager `jwt/signing` initially seeded with the CURRENT JWT secret value (step 2)
- Overwritten with a new random value at step 6 (same step as RDS)
- The `force-new-deployment` at step 8 makes tasks re-read it — all JWTs issued before that point fail verification and users re-auth. Pre-go-live, free. Post-go-live, schedule in a quiet window and warn users.

### Pre-flight items for any Tier 3 secret rotation on a containerised stack

See `../WORKFLOW.md` → "Latent bugs exposed during Tier 3 migrations" for the full set. The short version:

- Grep the frontend for any absolute `localhost:` URL used as a fallback — Vite/webpack/Next.js bake env vars at build time and a missing `VITE_API_URL` will ship with a broken localhost URL
- Grep the backend for DB/Redis/etc. clients with no explicit TLS config — may be relying on `NODE_TLS_REJECT_UNAUTHORIZED=0` which you're about to remove
- `ls packages/*/package-lock.json` — workspace lockfile coverage; `npm ci` in a per-package Dockerfile fails without a per-package lock

Each of these costs ~2 minutes at discovery. Hitting one during the rotation window costs 30-60 minutes plus a partial outage.

### Execution record, 2026-04-22

Actual run on this date:

1. Phase 1 (#4) — `taranis-dataroom-deploy` user created via AWS Console, policy attached, access key captured into Bitwarden, GitHub repo secrets updated, `deploy.bat` pinned to `AWS_PROFILE=TaranisCapital`, CLI smoke tests green, deactivated `taranis-deploy` user deleted.
2. Phase 2 (#5 + #6 + JWT) — three Secrets Manager secrets created (step 1), initially with newly-generated random values in `rds/master` (deviation from the corrected sequence above — fixed mid-run at "step 2.4.5" by overwriting `rds/master` back to the current RDS password `TaranisCap2026xSecure`). Exec-role inline policy attached (step 3). Task-def `:5` registered via ECS Console (step 4). Service roll to `:5` failed because three latent bugs surfaced simultaneously: pg.Pool had no `ssl:` config (fixed in `packages/api/src/db.js`), Dockerfile `npm ci` failed without workspace lockfile (fixed in both Dockerfiles), and the initial roll happened before the Secrets Manager sync-to-current-password (recovered by registering `:6` via CI after code fix + reverting SM to current password). Task-def `:6` stabilised (step 5). `rds/master` overwritten to new random, RDS Modify executed with `--apply-immediately` to the same new value, `force-new-deployment` fired (steps 6-8). Final blocker was a fourth latent bug — frontend defaulted `VITE_API_URL` to `http://localhost:4000` when unset, which CI-built images didn't set; fixed in `packages/web/src/` across four files and shipped via CI; login confirmed working on the final task.

Total elapsed from Phase 1 start to login confirmed: approximately 4 hours, vs the ~30-minute estimate in the original runbook. The delta was entirely the three latent bugs plus the Appendix-B ordering bug — none of which are project-specific, all now documented as pre-flight checks in `../WORKFLOW.md`.

---

*Written 2026-04-21 during the Tier 3 discovery pass; corrected 2026-04-22 after execution. Updates go through a normal pull request + Mark's review on `Walkerma75/taranis-dataroom`.*
