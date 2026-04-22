# ---------- Stage 1: install production deps ----------
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
# Using npm install rather than npm ci because the monorepo's authoritative
# lockfile lives at the repo root (npm workspaces); packages/api does not
# carry its own package-lock.json. Reproducibility trade-off documented —
# revisit when/if we refactor the Dockerfile to build from repo-root context
# with the root lockfile copied in.
RUN npm install --omit=dev

# ---------- Stage 2: production image ----------
FROM node:20-alpine

# LibreOffice for Word-to-PDF conversion
RUN apk add --no-cache libreoffice

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN mkdir -p uploads

ENV NODE_ENV=production
EXPOSE 4000

CMD ["npm", "run", "start"]
