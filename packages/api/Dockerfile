# ---------- Stage 1: install production deps ----------
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

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
