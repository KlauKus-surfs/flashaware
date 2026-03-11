# ── Stage 1: Build server ───────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY *.ts ./
RUN npx tsc

# ── Stage 2: Production ────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Python 3 for NetCDF subprocess parsing (used by eumetsatService.ts)
RUN apk add --no-cache python3 py3-pip py3-numpy \
    hdf5-dev netcdf-dev gcc musl-dev python3-dev \
    && pip3 install --break-system-packages netCDF4 \
    && apk del gcc musl-dev python3-dev

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY parse_nc_json.py ./parse_nc_json.py

# Pre-built React frontend (copied into server dir before deploy)
COPY client-dist/ ./client/dist/

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/index.js"]
