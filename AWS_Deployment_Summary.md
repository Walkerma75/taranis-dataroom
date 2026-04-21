# Taranis Data Room — AWS Deployment Summary

**Date:** 8 April 2026
**Target Domain:** dataroom.taraniscapital.com
**AWS Region:** eu-west-2 (London)
**GitHub:** Walkerma75/taranis-dataroom (Private)

---

## Status Overview

| Phase | Status | Notes |
|-------|--------|-------|
| 1. Production Dockerfiles | COMPLETE | Multi-stage builds for API and Web |
| 2. GitHub Repository | PARTIAL | Repo created (private), code push pending |
| 3. AWS Infrastructure | NOT STARTED | AWS Console session expired |
| 4. Docker Image Build/Push | NOT STARTED | GitHub Actions workflow created |
| 5. Migrations & Verification | NOT STARTED | Depends on Phase 3 & 4 |
| 6. This Summary | COMPLETE | — |

---

## What Was Completed

### Phase 1: Production Dockerfiles & Configs

**API Dockerfile** (`packages/api/Dockerfile`):
- Multi-stage build with node:20-alpine
- Installs LibreOffice for Word-to-PDF conversion
- Uses `npm ci --omit=dev` for production dependencies
- Runs `npm run start` (not dev)
- Creates uploads directory

**Web Dockerfile** (`packages/web/Dockerfile`):
- Multi-stage build: node:20-alpine builder + nginx:alpine server
- Builds production bundle with `npm run build`
- Serves static files via nginx

**Nginx Config** (`packages/web/nginx.conf`):
- SPA routing with `try_files $uri $uri/ /index.html`
- Proxies `/api/` requests to `localhost:4000` (works in ECS Fargate where containers share localhost)
- Static asset caching with 1-year expiry
- 50MB upload limit for document uploads

**Other files created:**
- `packages/api/.dockerignore` — excludes node_modules, dist, .env, uploads
- `packages/web/.dockerignore` — excludes node_modules, dist, .env
- `packages/web/vite.config.js` — updated to support `VITE_API_URL` env variable
- `.github/workflows/deploy.yml` — full CI/CD pipeline (see below)
- `.gitignore` — project-level ignores

### Phase 2: GitHub Repository

- **Repository created:** https://github.com/Walkerma75/taranis-dataroom (Private)
- **Main branch initialised** with README.md
- **Code not yet pushed** — the sandbox environment cannot reach GitHub's network, and creating a Personal Access Token requires email verification (sudo mode)

### GitHub Actions CI/CD Workflow

Created `.github/workflows/deploy.yml` which will:
1. Build API and Web Docker images
2. Push to ECR with both `latest` and commit SHA tags
3. Update ECS task definition with new images
4. Deploy to ECS with service stability wait

**Required GitHub Secrets** (to be set in repo Settings > Secrets):
- `AWS_ACCOUNT_ID` — your 12-digit AWS account ID
- `AWS_ACCESS_KEY_ID` — IAM user access key (create during Phase 3)
- `AWS_SECRET_ACCESS_KEY` — IAM user secret key

---

## What Remains — Step-by-Step Guide

### Step A: Push Code to GitHub

From your local machine (Windows), open a terminal in the `taranis-dataroom` folder:

```bash
cd "C:\Users\mark\Claude Cowork\Taranis Dataroom\taranis-dataroom"
git init -b main
git add -A
git commit -m "Initial commit: Taranis Capital Data Room"
git remote add origin https://github.com/Walkerma75/taranis-dataroom.git
git push -u origin main
```

You'll be prompted for GitHub credentials (use a Personal Access Token if you have 2FA enabled).

### Step B: AWS Infrastructure (via AWS Console, eu-west-2)

#### B1. VPC
- Go to **VPC Console > Create VPC**
- Use "VPC and more" wizard
- Name: `taranis-dataroom`
- CIDR: `10.0.0.0/16`
- 2 Availability Zones
- 2 public subnets (`10.0.1.0/24`, `10.0.2.0/24`)
- 2 private subnets (`10.0.3.0/24`, `10.0.4.0/24`)
- NAT Gateway: 1 (to save cost)
- DNS hostnames: enabled

#### B2. Security Groups (in the new VPC)
1. **taranis-alb-sg**: Inbound TCP 80 + 443 from `0.0.0.0/0`
2. **taranis-ecs-sg**: Inbound TCP 4000 from taranis-alb-sg only
3. **taranis-rds-sg**: Inbound TCP 5432 from taranis-ecs-sg only

#### B3. RDS PostgreSQL
- Engine: PostgreSQL 16
- Template: Free tier
- Identifier: `taranis-dataroom`
- Master username: `taranis`
- Master password: **generate and save a strong password**
- Instance: db.t3.micro or db.t4g.micro
- Storage: 20 GB gp3
- VPC: taranis-dataroom
- Subnet group: new, using 2 private subnets
- Security group: taranis-rds-sg
- Public access: No
- Initial DB name: `dataroom`

#### B4. ECR Repositories
Create two private repos:
- `taranis-dataroom/api`
- `taranis-dataroom/web`

#### B5. S3 Bucket for Documents
- Name: `taranis-dataroom-documents-prod`
- Region: eu-west-2
- Block all public access: Yes
- Versioning: Enabled

#### B6. ACM Certificate
- Domain: `dataroom.taraniscapital.com`
- Validation: DNS (add CNAME to Route 53)

#### B7. Application Load Balancer
- Name: `taranis-dataroom-alb`
- Scheme: Internet-facing
- VPC: taranis-dataroom, both public subnets
- Security group: taranis-alb-sg
- Target group: `taranis-dataroom-tg`, type IP, port 80, health check `/`
- HTTPS listener (443): forward to target group, use ACM cert
- HTTP listener (80): redirect to HTTPS

#### B8. ECS Cluster & Service
- Cluster name: `taranis-dataroom`, Fargate

**Task Definition:**
- Family: `taranis-dataroom`
- Fargate, Linux/X86_64
- 1 vCPU, 2 GB memory

**Container 1 — api:**
- Image: `{account-id}.dkr.ecr.eu-west-2.amazonaws.com/taranis-dataroom/api:latest`
- Port: 4000
- Environment variables:
  - `NODE_ENV=production`
  - `API_PORT=4000`
  - `POSTGRES_HOST={RDS endpoint}`
  - `POSTGRES_PORT=5432`
  - `POSTGRES_USER=taranis`
  - `POSTGRES_PASSWORD={RDS password}`
  - `POSTGRES_DB=dataroom`
  - `JWT_SECRET={generate 64-char random string}`

**Container 2 — web:**
- Image: `{account-id}.dkr.ecr.eu-west-2.amazonaws.com/taranis-dataroom/web:latest`
- Port: 80
- Essential: yes

**Service:**
- Name: `taranis-dataroom-service`
- Fargate, 1 desired task
- Private subnets, taranis-ecs-sg
- Attach to ALB target group

#### B9. Route 53 DNS
- Hosted zone: taraniscapital.com
- Record: `dataroom` — A record, Alias to the ALB

#### B10. IAM User for CI/CD
- Create IAM user: `taranis-deploy`
- Attach policies: AmazonEC2ContainerRegistryPowerUser, custom ECS deploy policy
- Create access key and add to GitHub Secrets

### Step C: Build & Push Images

Once AWS infra is up and code is pushed, either:
1. **Trigger GitHub Actions** — push to main triggers the workflow
2. **Manual build** — from local machine with Docker + AWS CLI:
   ```bash
   aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin {account-id}.dkr.ecr.eu-west-2.amazonaws.com
   cd packages/api && docker build -t {account-id}.dkr.ecr.eu-west-2.amazonaws.com/taranis-dataroom/api:latest . && docker push {account-id}.dkr.ecr.eu-west-2.amazonaws.com/taranis-dataroom/api:latest
   cd ../web && docker build -t {account-id}.dkr.ecr.eu-west-2.amazonaws.com/taranis-dataroom/web:latest . && docker push {account-id}.dkr.ecr.eu-west-2.amazonaws.com/taranis-dataroom/web:latest
   ```

### Step D: Run Migrations

After ECS is running:
```bash
aws ecs execute-command --cluster taranis-dataroom \
  --task {task-id} --container api \
  --interactive --command "npm run migrate && npm run seed"
```

### Step E: Verify
1. Navigate to https://dataroom.taraniscapital.com
2. Log in as `admin@taraniscapital.com` using the password supplied via the `SEED_ADMIN_PASSWORD` environment variable at first seed. See `MIGRATION-INVENTORY.md` for the current Secrets Manager reference.
3. Rotate that initial password via the app's Change Password screen before onboarding any users.

---

## Architecture Diagram

```
Internet
    │
    ▼
Route 53 (dataroom.taraniscapital.com)
    │
    ▼
ALB (taranis-dataroom-alb) ── public subnets
    │ HTTPS:443
    ▼
ECS Fargate Task ── private subnets
    ├── web (nginx:80) ── serves React SPA, proxies /api
    └── api (node:4000) ── Express API
            │
            ▼
        RDS PostgreSQL 16 ── private subnets
        (taranis-dataroom)
```

---

## Estimated AWS Costs (Monthly)

| Service | Estimate |
|---------|----------|
| ECS Fargate (1 task, 1 vCPU, 2 GB) | ~£25 |
| RDS db.t3.micro (free tier year 1) | £0–£12 |
| ALB | ~£15 |
| NAT Gateway | ~£28 |
| S3 + data transfer | ~£2 |
| Route 53 | ~£0.50 |
| **Total** | **~£70–£83/month** |

---

## Post-Deployment Checklist

- [ ] Change default admin password
- [ ] Enable RDS automated backups (7-day retention)
- [ ] Set up CloudWatch alarms (CPU, memory, 5xx errors)
- [ ] Enable ECS container insights
- [ ] Configure S3 lifecycle rules for document versioning
- [ ] Set up AWS Budget alerts
- [ ] Review and tighten IAM permissions
- [ ] Enable WAF on the ALB (optional)
- [ ] Set up log retention in CloudWatch
