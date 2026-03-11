#!/usr/bin/env bash
set -euo pipefail

# Lightning Risk MVP — Fly.io Deploy Script
# Prerequisites: flyctl installed, authenticated (fly auth login)

echo "=== Lightning Risk — Fly.io Deployment ==="

# ── 1. Create Postgres cluster (first time only) ────────────
echo ""
echo "── Step 1: PostgreSQL + PostGIS ──"
if fly apps list | grep -q "lightning-risk-db"; then
  echo "Database app already exists, skipping creation."
else
  echo "Creating Fly Postgres cluster..."
  fly postgres create \
    --name lightning-risk-db \
    --region jnb \
    --vm-size shared-cpu-1x \
    --initial-cluster-size 1 \
    --volume-size 1
  echo "Waiting for database to be ready..."
  sleep 10
fi

# ── 2. Deploy API server ────────────────────────────────────
echo ""
echo "── Step 2: API Server ──"

# Copy Python parser into server dir for Docker build
cp ingestion/parse_nc_json.py server/parse_nc_json.py
echo "Copied parse_nc_json.py to server/"

cd server

# Create app if it doesn't exist
if ! fly apps list | grep -q "lightning-risk-api"; then
  fly apps create lightning-risk-api --machines
fi

# Attach Postgres (first time only — sets DATABASE_URL secret)
if ! fly secrets list -a lightning-risk-api | grep -q "DATABASE_URL"; then
  echo "Attaching Postgres to API server..."
  fly postgres attach lightning-risk-db -a lightning-risk-api
fi

echo "Deploying API server..."
fly deploy

# Clean up copied file
rm -f parse_nc_json.py
cd ..

# ── 3. Deploy Ingestion Worker ──────────────────────────────
echo ""
echo "── Step 3: Ingestion Worker ──"
cd ingestion

if ! fly apps list | grep -q "lightning-risk-ingestion"; then
  fly apps create lightning-risk-ingestion --machines
fi

# Attach Postgres (first time only)
if ! fly secrets list -a lightning-risk-ingestion | grep -q "DATABASE_URL"; then
  echo "Attaching Postgres to ingestion worker..."
  fly postgres attach lightning-risk-db -a lightning-risk-ingestion
fi

echo "Deploying ingestion worker..."
fly deploy

cd ..

# ── 4. Initialize database schema ───────────────────────────
echo ""
echo "── Step 4: Database Schema ──"
echo "Applying schema.sql to Fly Postgres..."
fly postgres connect -a lightning-risk-db < db/schema.sql || echo "Schema may already be applied (OK if tables exist)"

# ── 5. Set secrets ──────────────────────────────────────────
echo ""
echo "── Step 5: Secrets ──"
echo "IMPORTANT: Set the following secrets manually:"
echo ""
echo "  # API Server secrets:"
echo "  fly secrets set -a lightning-risk-api \\"
echo "    JWT_SECRET=\"\$(openssl rand -hex 32)\" \\"
echo "    EUMETSAT_CONSUMER_KEY=\"your-key\" \\"
echo "    EUMETSAT_CONSUMER_SECRET=\"your-secret\" \\"
echo "    SMTP_HOST=\"smtp.gmail.com\" \\"
echo "    SMTP_USER=\"your-email@gmail.com\" \\"
echo "    SMTP_PASS=\"your-app-password\" \\"
echo "    ALERT_FROM=\"lightning-alerts@yourdomain.com\" \\"
echo "    CORS_ORIGIN=\"https://lightning-risk.pages.dev\""
echo ""
echo "  # Ingestion Worker secrets:"
echo "  fly secrets set -a lightning-risk-ingestion \\"
echo "    EUMETSAT_CONSUMER_KEY=\"your-key\" \\"
echo "    EUMETSAT_CONSUMER_SECRET=\"your-secret\""
echo ""

# ── 6. Summary ──────────────────────────────────────────────
echo "=== Deployment Complete ==="
echo ""
echo "Services:"
echo "  API:       https://lightning-risk-api.fly.dev"
echo "  Health:    https://lightning-risk-api.fly.dev/api/health"
echo "  DB:        lightning-risk-db.internal (Fly private network)"
echo "  Worker:    lightning-risk-ingestion (background, no public URL)"
echo "  Frontend:  Deploy client/ to Cloudflare Pages (see README)"
echo ""
echo "Next: Deploy the React frontend to Cloudflare Pages"
echo "  cd client && npm run build"
echo "  npx wrangler pages deploy dist --project-name=lightning-risk"
