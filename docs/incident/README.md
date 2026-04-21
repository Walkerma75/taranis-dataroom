# Incident file — 8 April 2026 secret exposure in `Walkerma75/taranis-dataroom`

**Opened:** 21 April 2026
**Severity when found:** Sev 1 (live AWS access key + RDS master password + application admin password committed to a private GitHub repo).
**Severity after containment:** Sev 2 (all four secrets either deactivated, rotated, or scheduled for rotation; CloudTrail review clean; history scrub pending).
**Closed:** pending — closes when the git-history scrub + force-push complete and the RDS password rotation is logged as done in `../../../TASKS.md`.

This folder contains the evidence trail for the incident. It lives in the repo so it is carried alongside future audits.

---

## 1. What was exposed

Committed to `main` on 2026-04-08 (first push). Enumerated in full in [`secrets-inventory.md`](./secrets-inventory.md).

| # | Secret | Tail / identifier | In production? | Rotated? |
|---|---|---|---|---|
| 1 | AWS Access Key ID | `AKIA…OP7D` (IAM user `taranis-deploy`) | No — deactivated during Taranis Capital static-website cleanup | Yes (deactivated) |
| 2 | AWS Secret Access Key | paired with #1 | No — dead with #1 | Yes |
| 3 | RDS master password | DB user `taranis` on `taranis-dataroom.ctkml66yk82u.eu-west-2.rds.amazonaws.com` | Yes, still live at time of writing | No — scheduled in `TASKS.md` |
| 4 | App admin password `<default-admin-password>` | `admin@taraniscapital.com` | No — rotated in-app by Mark on 2026-04-21 | Yes (value in history still to be scrubbed) |

## 2. CloudTrail review — `AKIA…OP7D`

- **Query:** `aws cloudtrail lookup-events --lookup-attributes AttributeKey=AccessKeyId,AttributeValue=AKIA...OP7D --start-time 2026-01-21T00:00:00Z --end-time 2026-04-21T23:59:59Z --max-results 1000 --region eu-west-2`
- **Window:** 2026-01-21 → 2026-04-21 (full 90-day CloudTrail Event-history retention, eu-west-2)
- **Raw result:** [`cloudtrail-akia-OP7D.json`](./cloudtrail-akia-OP7D.json) — `{"Events": []}`
- **Events found:** 0
- **Unique source IPs:** none
- **Unique user agents:** none
- **Post-deactivation error events:** none

### Interpretation

Zero events across the full 90-day window is strong evidence that the `AKIA…OP7D` key **was never used to sign an AWS API call**, during or after the period it was exposed on GitHub. Most probable explanation: the key was generated on 2026-04-08 to populate the `DEPLOY_NOW.md` cheat-sheet and the GitHub Actions secrets, but Mark's actual deploys were run from the laptop using the separate `AKIA…EE4G` key (also on `taranis-deploy`, also now deactivated), and the GitHub Actions workflow was never wired up in practice. The `OP7D` key sat unused until it was deactivated during the Taranis Capital static-website cleanup.

### Caveats

Honest acknowledgement of what this result does *not* prove:

1. **CloudTrail Event history covers management events only.** Data-plane events (e.g. `s3:GetObject`, `s3:PutObject`) require CloudTrail data-events logging to be explicitly enabled on a trail. The account-level trail `taranis-capital-account-trail` was enabled on 2026-04-20 per the website migration register — before that, data events were not being captured anywhere. So, in theory, if the key had been used purely for S3 data-plane reads between 8 Apr and 20 Apr, those calls would not appear in this query. The `taranis-deploy` user's permissions per project notes are ECR + ECS deploy — not S3 data reads — so this caveat is near-academic, but recorded for completeness.
2. **Session credentials spawned via `AssumeRole`** would be logged under the resulting `ASIA…` identifier, not the original `AKIA…OP7D`. `taranis-deploy` is a plain IAM user rather than a role-chaining setup, so this is also near-academic. None of the other investigation paths suggest role-chaining was in use.
3. **The key could have been used outside the 90-day window.** The key was committed on 2026-04-08, 13 days before the query, so the in-window period covers everything from 77 days before the commit (irrelevant — key did not yet exist anywhere that could exfiltrate it) to today. No gap.

### Cross-check questions for Mark

These are not blockers — the CloudTrail negative is good enough to proceed — but worth confirming for completeness:

- [ ] Did GitHub's push-protection / secret scanning send an email alert on 2026-04-08 (or shortly after) for the `AKIA…OP7D` key? (GitHub has automatic AWS-key detection on private repos.) If yes, what was the timeline and did anyone acknowledge it?
- [ ] Is AWS GuardDuty enabled in account `571600836975`? If so, did it emit a `CredentialAccess:IAMUser/AnomalousBehavior` or `UnauthorizedAccess:IAMUser/ConsoleLogin` finding between 8 Apr and the deactivation date?
- [ ] Is AWS Trusted Advisor's "Exposed Access Keys" check configured to email? (It pings GitHub's own API; usually catches exposed keys within hours.)

If the answer to any of these is "yes — there was an alert," that reframes the incident: the key was flagged, deactivation was the correct response, and the negative CloudTrail result is explained by the short exposure window (8 Apr commit → alert → deactivation) rather than by lack of attempted use. Either way the outcome is the same.

## 3. Remediation status

| Item | Status | Owner | Deadline |
|---|---|---|---|
| Deactivate `AKIA…OP7D` | Done | Mark | Pre-21 Apr (during website cleanup) |
| Deactivate `AKIA…EE4G` | Done | Mark | Pre-21 Apr |
| Create replacement IAM user `taranis-dataroom-deploy` (least-privilege to Dataroom resources only) | Not started | Mark | `TASKS.md` step 3 |
| Move DB password into AWS Secrets Manager | Not started | Mark | `TASKS.md` step 4 |
| Register new ECS task-definition revision referencing Secrets Manager | Not started | Mark | `TASKS.md` step 5 |
| Rotate RDS master password | Not started | Mark | `TASKS.md` step 6 |
| Rotate app admin password | Done | Mark | 2026-04-21 |
| Scrub four secrets from git history (`git filter-repo` + force-push) | Pending Mark's sign-off on this incident summary | Claude | Today's session |
| Rewrite `seed.js` + `index.js autoSeed()` to remove hard-coded `<default-admin-password>` | Pending — will commit on `scrub/pre-filter-repo` branch before the filter-repo run | Claude | Today's session |
| Delete `DEPLOY_NOW.md` entirely and rewrite `deploy.bat` / `AWS_Deployment_Summary.md` | Pending — same commit as above | Claude | Today's session |
| Backup WIP branch `wip/bulk-upload-8-apr` pushed to GitHub | Pending | Claude | Today's session |
| CloudTrail review | Done (this document) | Claude | 2026-04-21 |

## 4. Lessons

Not a post-mortem write-up yet — that's worth doing after the scrub lands. Provisional notes:

- The 8 April rush to get to production bundled the cheat-sheet (legitimate for private notes) into the committed tree. Root cause is that `DEPLOY_NOW.md` was created as a documentation artefact and committed without anyone asking "would I be comfortable with this file being public?"
- The git-filter-repo scrub only helps if we know the full set of secrets. The pre-scrub inventory at `secrets-inventory.md` is the artefact that catches anything missed. Worth keeping that inventory template around for future projects.
- GitHub push-protection on AWS-key patterns should be enabled repo-wide if it isn't already (free on private repos). Worth a one-line check post-scrub.
- Pre-commit secret-scanning (e.g. `gitleaks`, `detect-secrets`) as a `.pre-commit-config.yaml` hook is a reasonable TASKS.md follow-up.
