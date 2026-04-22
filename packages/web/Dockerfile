# ---------- Stage 1: build ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
# See packages/api/Dockerfile for rationale — workspace lockfile lives at repo
# root, not per-package.
RUN npm install

COPY . .
RUN npm run build

# ---------- Stage 2: serve ----------
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
