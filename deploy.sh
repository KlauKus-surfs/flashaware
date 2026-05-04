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

# We intentionally do NOT set VITE_WS_URL. The SPA opens the WebSocket
# against its own origin (whatever hostname the page is on), which keeps
# the connection same-origin with the API so the httpOnly fa_auth cookie
# rides on the upgrade. flashaware.com and lightning-risk-api.fly.dev are
# both served by the same Fly machine, so same-origin works on either.
# Hard-coding VITE_WS_URL to one host breaks the other (cross-origin
# cookies don't traverse different registrable domains, regardless of
# SameSite), which is exactly the regression we hit when the SPA loaded
# from flashaware.com but tried to upgrade WS to *.fly.dev.

(
  cd client
  echo "  Building client (origin-relative WS — no VITE_WS_URL)..."
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
echo "  # The SPA is bundled into this same Fly app under server/client-dist,"
echo "  # so there is no separate client deploy. Custom hostnames (e.g."
echo "  # flashaware.com) should be added as Fly certs on this app:"
echo "  #   fly certs add flashaware.com -a lightning-risk-api"
echo ""

# ── 6. Summary ──────────────────────────────────────────────
echo "=== Deployment Complete ==="
echo ""
echo "Services:"
echo "  API + SPA: https://lightning-risk-api.fly.dev (and any custom Fly certs)"
echo "  Health:    https://lightning-risk-api.fly.dev/api/health"
echo "  DB:        lightning-risk-db.internal (Fly private network)"
