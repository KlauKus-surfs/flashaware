"""
EUMETSAT MTG LI-2-LFL Product Collector — DEV/LOCAL ONLY.

Production no longer runs this as a separate process. The API
(server/eumetsatService.ts) does ingestion in-process under the
advisory-lock leader gate. See docs/OPERATIONS.md →
"Decommissioned services" for the rationale.

This module is kept around for two reasons:
  1. `ingester.py` (imported here) is useful as a CLI for one-shot
     ingestion of a downloaded `.nc` file during local development:
       python ingester.py path/to/CHK-BODY.nc
  2. Running the loop locally still works — pointed at a local
     Postgres with the schema applied — and is occasionally useful
     for debugging the EUMETSAT side without involving the full API.

Do not redeploy this as a standalone Fly app. Its previous deploy
(lightning-risk-ingestion) was attached to a separate database from
the API, so its writes were silently invisible to /api/health and
the risk engine.

Discovers new lightning flash products from EUMETSAT Data Store.
Runs on a cron schedule (every 2 minutes) or as a one-shot.
"""

import os
import sys
import json
import time
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    before_sleep_log,
)

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("collector")

CONSUMER_KEY = os.getenv("EUMETSAT_CONSUMER_KEY", "")
CONSUMER_SECRET = os.getenv("EUMETSAT_CONSUMER_SECRET", "")
COLLECTION_ID = os.getenv("EUMETSAT_COLLECTION_ID", "EO:EUM:DAT:0691")
DATA_DIR = Path(__file__).resolve().parent / "data"
STATE_FILE = DATA_DIR / "collector_state.json"

# Retry: 3 attempts, 2s/4s/8s backoff (capped at 10s).
_RETRY_KW = dict(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_exception_type(Exception),
    reraise=True,
    before_sleep=before_sleep_log(log, logging.WARNING),
)


def load_state() -> dict:
    """Load last-seen product timestamp from state file."""
    if STATE_FILE.exists():
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"last_product_time": None, "last_run": None, "last_ingested_product_id": None}


def save_state(state: dict):
    """Persist collector state."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def update_collector_heartbeat(*, success: bool) -> None:
    """Upsert heartbeat rows in app_settings.

    NOTE: in production this is a no-op — the Python ingestion service is
    attached to a separate database (lightning_risk_ingestion) from the API
    (lightning_risk_api), so writes here are never observed by the API's
    /api/health enrichment. The authoritative heartbeat lives in the API's
    eumetsatService.ts which runs the actual in-process ingestion. We keep
    this function so dev/local setups (where one DB serves both processes)
    continue to surface collector liveness.

    Errors are logged at debug level — the architecture mismatch above
    means a "relation does not exist" warning every 2 minutes is misleading
    noise rather than an actionable signal.
    """
    try:
        from ingester import get_db_connection
        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """INSERT INTO app_settings (key, value, updated_at)
                   VALUES ('collector_last_attempt_at', NOW()::text, NOW())
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                     updated_at = NOW()"""
            )
            if success:
                cur.execute(
                    """INSERT INTO app_settings (key, value, updated_at)
                       VALUES ('collector_last_success_at', NOW()::text, NOW())
                       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                         updated_at = NOW()"""
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        log.debug(f"Could not update collector heartbeat: {e}")


def already_ingested_product_ids(product_ids: list[str]) -> set[str]:
    """Return the subset of given product_ids that already have a non-ERROR
    ingestion_log row. Saves a re-download when the collector restarts within
    the lookback window (cheap precheck — DB still rejects duplicates via
    UNIQUE constraints on flash_events and ingestion_log)."""
    if not product_ids:
        return set()
    try:
        # Imported lazily so the module still loads in environments without
        # psycopg2 installed (e.g. demo mode).
        import psycopg2
        from ingester import get_db_connection
        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT product_id FROM ingestion_log "
                "WHERE product_id = ANY(%s) AND qc_status != 'ERROR'",
                [product_ids],
            )
            return {row[0] for row in cur.fetchall()}
        finally:
            conn.close()
    except Exception as e:
        log.warning(f"Could not check ingestion_log for already-ingested products: {e}")
        return set()


@retry(**_RETRY_KW)
def _do_discover(lookback_minutes: int) -> list:
    import eumdac

    credentials = eumdac.AccessToken(credentials=(CONSUMER_KEY, CONSUMER_SECRET))
    datastore = eumdac.DataStore(credentials)
    collection = datastore.get_collection(COLLECTION_ID)

    now = datetime.now(timezone.utc)
    start = now - timedelta(minutes=lookback_minutes)

    products = collection.search(dtstart=start, dtend=now)
    product_list = []
    for product in products:
        product_list.append(
            {
                "id": str(product),
                "title": getattr(product, "title", str(product)),
                "sensing_start": getattr(product, "sensing_start", None),
                "sensing_end": getattr(product, "sensing_end", None),
                "size": getattr(product, "size", None),
            }
        )
    return product_list


def discover_products(lookback_minutes: int = 30) -> list:
    """
    Query EUMETSAT Data Store for recent LI-2-LFL products, with retry/backoff.
    """
    try:
        import eumdac  # noqa: F401  (test the import; _do_discover re-imports)
    except ImportError:
        log.warning("eumdac not installed — running in demo mode with no real data")
        return []
    try:
        product_list = _do_discover(lookback_minutes)
        log.info(f"Discovered {len(product_list)} product(s) in last {lookback_minutes} min")
        return product_list
    except Exception as e:
        log.error(f"Product discovery failed after retries: {e}")
        return []


@retry(**_RETRY_KW)
def _do_download(product_id: str) -> Path | None:
    import eumdac
    import zipfile
    import io

    credentials = eumdac.AccessToken(credentials=(CONSUMER_KEY, CONSUMER_SECRET))
    datastore = eumdac.DataStore(credentials)
    collection = datastore.get_collection(COLLECTION_ID)
    product = collection.get(product_id)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    with product.open() as fsrc:
        content = fsrc.read()
        zf = zipfile.ZipFile(io.BytesIO(content))

        body_files = [n for n in zf.namelist() if "CHK-BODY" in n and n.endswith(".nc")]
        trail_files = [n for n in zf.namelist() if "CHK-TRAIL" in n and n.endswith(".nc")]

        downloaded = {}
        for fname in body_files + trail_files:
            out_path = DATA_DIR / Path(fname).name
            with open(out_path, "wb") as fout:
                fout.write(zf.read(fname))
            file_type = "body" if "CHK-BODY" in fname else "trail"
            downloaded[file_type] = out_path
            log.info(f"Downloaded {file_type}: {out_path.name}")

        return downloaded.get("body")


def download_product(product_id: str) -> Path | None:
    """
    Download a specific product's BODY .nc file, with retry/backoff.
    Returns path to downloaded file or None on failure.
    """
    try:
        import eumdac  # noqa: F401
    except ImportError:
        log.warning("eumdac not installed — cannot download products")
        return None
    try:
        return _do_download(product_id)
    except Exception as e:
        log.error(f"Download failed for {product_id} after retries: {e}")
        return None


def run_collection_cycle():
    """Single collection cycle: discover → filter already-seen → download → ingest."""
    state = load_state()
    log.info("Starting collection cycle")

    products = discover_products(lookback_minutes=30)
    if not products:
        log.info("No new products found")
        save_state(state)
        return

    # Skip products we've already ingested (DB-level idempotency check).
    # Avoids re-downloading large .nc files when the collector restarts.
    seen = already_ingested_product_ids([p["id"] for p in products])
    if seen:
        log.info(f"Skipping {len(seen)} already-ingested product(s)")
    new_products = [p for p in products if p["id"] not in seen]

    for product in new_products:
        product_id = product["id"]
        log.info(f"Processing product: {product_id}")

        body_path = download_product(product_id)
        if body_path:
            from ingester import ingest_nc_file
            result = ingest_nc_file(str(body_path), product_id)
            if result:
                state["last_product_time"] = product.get(
                    "sensing_end", datetime.now(timezone.utc).isoformat()
                )
                state["last_ingested_product_id"] = product_id
                # Persist after each successful ingest so a mid-batch crash
                # doesn't lose progress.
                save_state(state)
                log.info(f"Successfully ingested {product_id}: {result['flash_count']} flashes")
            else:
                log.error(f"Ingestion failed for {product_id}")
        else:
            log.warning(f"Download failed for {product_id}, skipping")

    save_state(state)
    log.info("Collection cycle complete")


def main():
    """Entry point — run once or loop based on INGESTION_INTERVAL_SEC."""
    # Hard gate: the in-process ingester (server/eumetsatService.ts) is the
    # production code path, attached to the same DB the API reads from. If
    # this script runs against production it competes for the same EUMETSAT
    # API quota and writes flash_events into the same database — and used
    # to clobber the observability heartbeat too (now namespaced, but the
    # quota / write competition remains). Refuse to run unless the operator
    # explicitly opts in with --allow-prod, and even then log loudly.
    env = os.getenv("NODE_ENV") or os.getenv("ENV") or ""
    is_prod = env.lower() == "production"
    if is_prod and "--allow-prod" not in sys.argv:
        log.critical(
            "Refusing to run collector.py with NODE_ENV=production. "
            "The API runs ingestion in-process (server/eumetsatService.ts). "
            "If you genuinely need to run this script against prod (e.g. a "
            "one-off backfill), pass --allow-prod and accept the consequences."
        )
        sys.exit(2)
    if is_prod:
        log.warning(
            "collector.py is running in production with --allow-prod. "
            "This competes with the in-process ingester for EUMETSAT quota."
        )

    if not CONSUMER_KEY or not CONSUMER_SECRET:
        if is_prod:
            # Fail loud at boot. A silent no-op loop here means the risk
            # engine reports DEGRADED ~25 min later instead — a missing
            # secret should be a deploy failure, not a midnight page.
            log.critical(
                "EUMETSAT credentials NOT configured in production. "
                "Set EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET. Exiting."
            )
            sys.exit(1)
        log.warning(
            "EUMETSAT credentials not configured. "
            "Set EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET in .env"
        )

    if "--once" in sys.argv:
        try:
            run_collection_cycle()
            update_collector_heartbeat(success=True)
        except Exception:
            update_collector_heartbeat(success=False)
            raise
        return

    interval = int(os.getenv("INGESTION_INTERVAL_SEC", "120"))
    max_consecutive_failures = int(os.getenv("MAX_CONSECUTIVE_FAILURES", "10"))
    log.info(f"Starting collector loop (interval: {interval}s, max_failures: {max_consecutive_failures})")

    consecutive_failures = 0

    while True:
        try:
            run_collection_cycle()
            consecutive_failures = 0
            update_collector_heartbeat(success=True)
        except Exception as e:
            consecutive_failures += 1
            log.error(f"Collection cycle error ({consecutive_failures}/{max_consecutive_failures}): {e}")
            update_collector_heartbeat(success=False)
            if consecutive_failures >= max_consecutive_failures:
                log.critical(
                    f"Exceeded {max_consecutive_failures} consecutive failures — "
                    "exiting so Fly.io can restart the process."
                )
                sys.exit(1)
        time.sleep(interval)


if __name__ == "__main__":
    main()
