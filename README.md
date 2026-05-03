# ⚡ FlashAware

Real-time lightning risk decision system for South African outdoor operations (mines, golf courses, construction sites, events). Powered by EUMETSAT MTG Lightning Imager (LI-2-LFL) data.

## Risk States

| State         | Color     | Meaning                                       |
| ------------- | --------- | --------------------------------------------- |
| **ALL CLEAR** | 🟢 Green  | Safe to resume outdoor operations             |
| **PREPARE**   | 🟡 Yellow | Heightened risk — ready personnel for shelter |
| **STOP**      | 🔴 Red    | Suspend operations and shelter immediately    |
| **HOLD**      | 🟠 Orange | Remain sheltered, threat persists             |
| **DEGRADED**  | ⚪ Gray   | Data feed unhealthy — cannot determine risk   |

## Tech Stack

- **Frontend**: React 18, TypeScript, Material-UI, Leaflet.js
- **Backend**: Node.js, Express, TypeScript
- **Database**: PostgreSQL 16 + PostGIS 3.4
- **Ingestion**: in-process inside the API (`server/eumetsatService.ts`,
  shells out to a Python `parse_nc_json.py` for netCDF parsing)
- **Notifications**: Nodemailer (email), Twilio (SMS, WhatsApp)

## Quick Start

### Prerequisites

- **Node.js** 20+
- **Python** 3.11+
- **Docker** (for PostgreSQL + PostGIS)

### 1. Environment Setup

```bash
cd lightning-risk-mvp
cp .env.example .env
# Edit .env with your EUMETSAT credentials, SMTP settings, etc.
```

### 2. Start Database

```bash
docker compose up -d
```

The database schema is auto-applied on first start via `db/schema.sql`.

No admin user is seeded by default. For local development, set
`SEED_DEMO_ADMIN=true` before starting the server to insert
`admin@flashaware.com` with a placeholder password — the API forces a
rotation on first sign-in (and refuses to re-accept the placeholder),
so the well-known credential can't survive past the first login.

For production, insert a real super-admin manually instead — see the comment
block at the top of `db/schema.sql`.

### 3. Install & Start Server

```bash
cd server
npm install
npm run dev
```

Server runs on `http://localhost:4000`. Health check: `GET /api/health`.

### 4. Install & Start Client

```bash
cd client
npm install
npm run dev
```

Client runs on `http://localhost:3000` with API proxy to `:4000`.

### 5. Python Ingestion (Local dev only)

In production the API runs EUMETSAT ingestion in-process — there is no
separate ingestion service. The Python tooling under `ingestion/` is
preserved for one-shot local debugging only:

```bash
cd ingestion
pip install -r requirements.txt

# One-shot ingestion of a downloaded .nc file:
python ingester.py path/to/CHK-BODY.nc
```

The `collector.py` continuous loop still runs locally if you need to
reproduce an EUMETSAT auth issue without booting the full API, but it
is not deployed anywhere — see `docs/OPERATIONS.md` →
"Decommissioned services".

## Project Structure

```
flashaware/
├── package.json                    # Monorepo root
├── docker-compose.yml              # PostgreSQL + PostGIS
├── .env.example                    # Config template
├── README.md                       # This file
├── db/
│   └── schema.sql                  # Tables, indexes, PostGIS, seed data
├── server/
│   ├── package.json                # Server dependencies
│   ├── tsconfig.json               # TypeScript config
│   ├── index.ts                    # Express app, routes, startup
│   ├── db.ts                       # PostgreSQL pool, spatial query helpers
│   ├── auth.ts                     # JWT auth, RBAC middleware
│   ├── riskEngine.ts               # State machine, evaluation loop
│   └── alertService.ts             # Email dispatch, ack, escalation
├── ingestion/
│   ├── requirements.txt            # Python dependencies
│   ├── collector.py                # EUMETSAT product discovery (cron)
│   └── ingester.py                 # NetCDF parser, DB bulk insert
└── client/
    ├── package.json                # Client dependencies
    ├── index.html                  # Entry HTML
    ├── vite.config.ts              # Vite + API proxy
    ├── tsconfig.json               # TypeScript config
    └── src/
        ├── main.tsx                # React entry
        ├── App.tsx                 # Router, theme, layout, auth
        ├── Dashboard.tsx           # Live status cards + Leaflet map
        ├── LocationEditor.tsx      # Location CRUD + map centroid picker
        ├── AlertHistory.tsx        # Alert table with "why" explanations
        └── api.ts                  # Axios client, auth interceptor
```

## API Endpoints

| Method | Path                      | Auth      | Purpose                           |
| ------ | ------------------------- | --------- | --------------------------------- |
| GET    | `/api/health`             | Public    | System & feed health              |
| POST   | `/api/auth/login`         | Public    | JWT authentication                |
| GET    | `/api/locations`          | Viewer+   | List locations with current state |
| POST   | `/api/locations`          | Admin     | Create location                   |
| PUT    | `/api/locations/:id`      | Admin     | Update location                   |
| GET    | `/api/status`             | Viewer+   | All locations' risk state         |
| GET    | `/api/status/:locationId` | Viewer+   | Single location detail            |
| GET    | `/api/flashes`            | Viewer+   | Recent flash events               |
| GET    | `/api/alerts`             | Viewer+   | Alert history                     |
| POST   | `/api/ack/:alertId`       | Operator+ | Acknowledge alert                 |
| GET    | `/api/replay/:locationId` | Viewer+   | Historical replay data            |

## Risk Engine Logic

The engine evaluates each location every 60 seconds:

1. **Data freshness**: If no product received in 25 min → DEGRADED
2. **STOP check**: ≥3 flashes within 10 km (5 min) OR any flash < 5 km
3. **PREPARE check**: ≥1 flash within 20 km (15 min)
4. **HOLD**: After STOP, must wait 30 min with no flashes before ALL CLEAR
5. **ALL CLEAR**: No flashes in 20 km for ≥30 min AND data feed healthy

Key safety rules:

- **Never** issue ALL CLEAR with stale data
- HOLD is the safe intermediate between STOP and ALL CLEAR
- All transitions are logged with full JSONB explanations for audit

## Demo Locations (Opt-in Seed)

The four locations below are inserted only when `SEED_DEMO_LOCATIONS=true` is
set on a fresh database (no rows in `locations`). Production / hosted
deployments leave the variable unset, so the platform tenant ships empty and
real customer locations are added via the UI.

| Location                 | Coordinates       | Type         |
| ------------------------ | ----------------- | ------------ |
| Johannesburg CBD         | -26.2041, 28.0473 | Construction |
| Rustenburg Platinum Mine | -25.6667, 27.2500 | Mine         |
| Durban Beachfront        | -29.8587, 31.0218 | Event        |
| Sun City Golf Course     | -25.3346, 27.0928 | Golf Course  |

> Anything else you see in the platform tenant — `Replay demo …`,
> `Cape St. Francis`, `Framesby`, etc. — was added at runtime and is not part
> of the seed. Demo names should include the storm date as `YYYY-MM-DD` so
> dates like `04082026` aren't ambiguous (08 Apr vs Aug 4).

## Configuration

All thresholds are configurable per location:

| Parameter                 | Default | Description                |
| ------------------------- | ------- | -------------------------- |
| `stop_radius_km`          | 10      | STOP evaluation radius     |
| `prepare_radius_km`       | 20      | PREPARE evaluation radius  |
| `stop_flash_threshold`    | 3       | Flashes to trigger STOP    |
| `stop_window_min`         | 5       | Rolling window for STOP    |
| `prepare_flash_threshold` | 1       | Flashes to trigger PREPARE |
| `prepare_window_min`      | 15      | Rolling window for PREPARE |
| `allclear_wait_min`       | 30      | Wait time before ALL CLEAR |

## Deployment (Fly.io)

Hosted on [Fly.io](https://fly.io) (API + frontend + DB) in the Johannesburg region. **Free tier covers everything for demo use (~$0/mo).**

### Architecture

```
┌─ Fly.io (jnb region) ───────────────────────────┐
│  flashaware-api   (Node.js API + React frontend) │
│  flashaware-db    (Postgres + PostGIS)           │
└──────────────────────────────────────────────────┘
```

### Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated (`fly auth login`)

### Services & Cost

| Service               | Platform | Plan                             | Est. Cost    |
| --------------------- | -------- | -------------------------------- | ------------ |
| `flashaware-api`      | Fly.io   | shared-cpu-1x, 256MB (free tier) | $0/mo        |
| `flashaware-db`       | Fly.io   | Postgres 1GB (free tier)         | $0/mo        |
| **Total (demo)**      |          |                                  | **$0/mo**    |
| **Total (always-on)** |          | auto_stop=off on API             | **~$3-5/mo** |

### Live Instance

- **URL**: https://lightning-risk-api.fly.dev
- **Login**: created out-of-band; the API rejects `admin123` and any other
  default-password block-list entry, and forces a rotation on first sign-in.

### Post-Deploy Checklist

- [ ] Verify `/api/health` returns `status: ok`
- [ ] Sign in with the bootstrap admin and complete the forced
      password-rotation dialog before doing anything else.
- [ ] Confirm EUMETSAT data ingestion is running (check `feedHealthy` in health endpoint)

## License

MIT
