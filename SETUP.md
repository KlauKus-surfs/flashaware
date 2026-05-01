# FlashAware — Local Setup Guide (Windsurf + Windows)

This guide walks a new developer through cloning and running **FlashAware** locally on their own PC using **Windsurf** as the IDE. Target: a working `http://localhost:3000` frontend talking to `http://localhost:4000` API against a local PostgreSQL + PostGIS database.

---

## 1. Install Prerequisites

Install the following on the target PC before opening Windsurf:

- **Git** — https://git-scm.com/download/win
- **Node.js 20+** (includes `npm`) — https://nodejs.org/ (LTS)
- **Python 3.11+** — https://www.python.org/downloads/ (tick **"Add Python to PATH"** during install). Only needed if you want to run the ingestion scripts.
- **Docker Desktop** — https://www.docker.com/products/docker-desktop/ (required for the Postgres + PostGIS container). Start Docker Desktop and wait until it says **"Engine running"**.
- **Windsurf** — https://windsurf.com/download

Verify in a new PowerShell window:

```powershell
git --version
node --version
npm --version
python --version
docker --version
```

All five should print a version without error.

---

## 2. Clone the Repository

Open PowerShell in the folder where you keep projects, then:

```powershell
git clone <REPO_URL> lightning-risk-mvp
```

Replace `<REPO_URL>` with the repo's HTTPS or SSH URL (ask the owner if unsure).

---

## 3. Open the Project in Windsurf

1. Launch **Windsurf**.
2. `File` → `Open Folder...` → select the cloned `lightning-risk-mvp` directory.
3. When prompted, trust the workspace.
4. Open Windsurf's integrated terminal: `` Ctrl+` `` (ensure it is PowerShell).

All remaining commands are run from the Windsurf terminal at the project root.

---

## 4. Create the `.env` File

Copy the template and fill in credentials:

```powershell
Copy-Item .env.example .env
```

Open `.env` in Windsurf and **at minimum** set:

- `JWT_SECRET` — replace with any long random string.
- Leave `POSTGRES_*` values as defaults (they match `docker-compose.yml`).
- `EUMETSAT_CONSUMER_KEY` / `EUMETSAT_CONSUMER_SECRET` — only required if you plan to run live ingestion. Leave as placeholders otherwise; the app still starts.
- `SMTP_*` and `TWILIO_*` — only required if you want real email / SMS alerts. Leave as placeholders for local dev.

---

## 5. Start the Database (Docker)

From the project root:

```powershell
docker compose up -d
```

This starts a PostgreSQL 16 + PostGIS 3.4 container named `lightning-postgres` on port `5432` and auto-applies `db/schema.sql` on first run (creates tables, seeds demo locations, and creates the default admin user).

Verify:

```powershell
docker ps
```

You should see `lightning-postgres` with status `Up`.

**If you ever need to reset the DB from scratch:**

```powershell
docker compose down -v
docker compose up -d
```

---

## 6. Install & Start the API Server

```powershell
cd server
npm install
npm run dev
```

Leave this terminal running. The server listens on `http://localhost:4000`. Verify in a browser or new terminal:

```powershell
curl http://localhost:4000/api/health
```

Expected: JSON with `"status": "ok"`.

---

## 7. Install & Start the Frontend Client

Open a **second** terminal in Windsurf (`Terminal` → `New Terminal`) and run:

```powershell
cd client
npm install
npm run dev
```

Vite serves the app on `http://localhost:3000` and proxies `/api/*` to the server on port 4000.

Open `http://localhost:3000` in a browser and sign in. For local dev, start the
server with `SEED_DEMO_ADMIN=true` to insert the placeholder super-admin
(`admin@flashaware.com` with the well-known dev password) — the API will
immediately force you to rotate it on first sign-in. For production, insert a
real super-admin manually instead (see the comment block at the top of
`db/schema.sql`).

---

## 8. (Optional) Run the Python Ingestion

Only needed if you want to pull real EUMETSAT lightning data locally. Requires valid `EUMETSAT_CONSUMER_KEY` / `SECRET` in `.env`.

In a third terminal:

```powershell
cd ingestion
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# Ingest a single .nc file:
python ingester.py path\to\CHK-BODY.nc

# Or run the continuous collector:
python collector.py
```

Without this step, the dashboard still loads but will show no live flash data and the feed health will eventually report `DEGRADED`.

---

## 9. Daily Workflow

Once installed, starting the stack on subsequent days only requires:

```powershell
docker compose up -d          # from project root
cd server; npm run dev        # terminal 1
cd client; npm run dev        # terminal 2
```

To stop:

- `Ctrl+C` in each `npm run dev` terminal
- `docker compose down` to stop the database (data persists in a Docker volume)

---

## 10. Common Issues

- **`docker: command not found`** — Docker Desktop is not running. Start it and wait for the whale icon to be steady.
- **Port 5432 already in use** — another Postgres is running locally. Stop it or change `POSTGRES_PORT` in `.env` and `docker-compose.yml`.
- **Port 3000 or 4000 in use** — change `SERVER_PORT` in `.env` or pass `--port` to Vite in `client/package.json` dev script.
- **`npm install` fails on `node-gyp`** — install the Windows build tools: `npm install --global windows-build-tools` (run PowerShell as admin), or upgrade Node to 20 LTS.
- **Login fails** — confirm the DB container started fresh (schema seeded the admin user). If it was started before `db/schema.sql` existed, run `docker compose down -v` and bring it back up.
- **Blank dashboard / no flashes** — expected without ingestion. See step 8.

---

## 11. Using Windsurf's Cascade

Once the project is open, you can ask Cascade (the AI pair-programmer inside Windsurf) things like:

- "Run the dev server and client for me."
- "Check why `/api/health` is returning degraded."
- "Add a new seed location in `db/schema.sql`."

Cascade has access to this repo and can run terminal commands after your approval.

---

You are done. The app should now be running at **http://localhost:3000**.
