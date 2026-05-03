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

# ── 2. Build SPA + copy into server fallback path ──────────
echo ""
echo "── Step 2: Build client SPA ──"

# VITE_WS_URL must be set at build time so the prod SPA points the websocket
# at the API origin (otherwise realtime falls back to 15s polling silently).
# Auto-derive from the deployed Fly hostname when the caller hasn't set it
# explicitly — saves an out-of-band manual step on a fresh clone deploy.
if [ -z "${VITE_WS_URL:-}" ]; then
  if fly apps list 2>/dev/null | grep -q "lightning-risk-api"; then
    DERIVED_HOST=$(fly status -a lightning-risk-api --json 2>/dev/null \
      | sed -n 's/.*"Hostname": *"\([^"]*\)".*/\1/p' | head -n 1)
    if [ -n "${DERIVED_HOST:-}" ]; then
      export VITE_WS_URL="https://${DERIVED_HOST}"
      echo "  Auto-derived VITE_WS_URL=${VITE_WS_URL} from fly status"
    fi
  fi
fi
if [ -z "${VITE_WS_URL:-}" ]; then
  export VITE_WS_URL="https://lightning-risk-api.fly.dev"
  echo "  WARN: Could not derive VITE_WS_URL from fly. Falling back to ${VITE_WS_URL}"
  echo "        (Set explicitly via 'export VITE_WS_URL=...' to override.)"
fi

(
  cd client
  echo "  Building client (VITE_WS_URL=${VITE_WS_URL})..."
  npm run build
)
rm -rf server/client-dist
cp -r client/dist server/client-dist
echo "  Copied fresh client/dist → server/client-dist"

# ── 3. Deploy API server ────────────────────────────────────
echo ""
echo "── Step 3: API Server ──"

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

# Note: there is no longer a step 4 (separate ingestion worker). The API
# runs EUMETSAT ingestion in-process via server/eumetsatService.ts under the
# advisory-lock leader gate. If you previously deployed `lightning-risk-ingestion`,
# destroy it manually: `fly apps destroy lightning-risk-ingestion`.

# ── 4. Initialize database schema ───────────────────────────
echo ""
echo "── Step 4: Database Schema ──"
echo "Applying schema.sql to Fly Postgres..."
fly postgres connect -a lightning-risk-db < db/schema.sql || echo "Schema may already be applied (OK if tables exist)"

echo ""
echo "── Step 5: Secrets ──"
echo "IMPORTANT: Set the following secrets manually on lightning-risk-api"
echo "(everything runs in one process — no separate ingestion app):"
echo ""
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
echo "  # Cloudflare Pages env (set in dashboard, then redeploy SPA):"
echo "    VITE_WS_URL=https://lightning-risk-api.fly.dev"
echo ""

# ── 6. Summary ──────────────────────────────────────────────
echo "=== Deployment Complete ==="
echo ""
echo "Services:"
echo "  API:       https://lightning-risk-api.fly.dev"
echo "  Health:    https://lightning-risk-api.fly.dev/api/health"
echo "  DB:        lightning-risk-db.internal (Fly private network)"
echo "  Frontend:  Deploy client/ to Cloudflare Pages (see README)"
echo ""
echo "Next: Deploy the React frontend to Cloudflare Pages"
echo "  cd client && npm run build  # uses VITE_WS_URL from environment"
echo "  npx wrangler pages deploy dist --project-name=lightning-risk"
