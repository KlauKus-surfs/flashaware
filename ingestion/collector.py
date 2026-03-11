"""
EUMETSAT MTG LI-2-LFL Product Collector
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


def load_state() -> dict:
    """Load last-seen product timestamp from state file."""
    if STATE_FILE.exists():
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"last_product_time": None, "last_run": None}


def save_state(state: dict):
    """Persist collector state."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def discover_products(lookback_minutes: int = 30) -> list:
    """
    Query EUMETSAT Data Store for recent LI-2-LFL products.
    Uses the eumdac client library for authentication and search.
    """
    try:
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
        log.info(f"Discovered {len(product_list)} product(s) in last {lookback_minutes} min")
        return product_list

    except ImportError:
        log.warning("eumdac not installed — running in demo mode with no real data")
        return []
    except Exception as e:
        log.error(f"Product discovery failed: {e}")
        return []


def download_product(product_id: str) -> Path | None:
    """
    Download a specific product's BODY .nc file.
    Returns path to downloaded file or None on failure.
    """
    try:
        import eumdac

        credentials = eumdac.AccessToken(credentials=(CONSUMER_KEY, CONSUMER_SECRET))
        datastore = eumdac.DataStore(credentials)
        collection = datastore.get_collection(COLLECTION_ID)
        product = collection.get(product_id)

        DATA_DIR.mkdir(parents=True, exist_ok=True)

        # Download and extract BODY file
        with product.open() as fsrc:
            import zipfile
            import io

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

    except ImportError:
        log.warning("eumdac not installed — cannot download products")
        return None
    except Exception as e:
        log.error(f"Download failed for {product_id}: {e}")
        return None


def run_collection_cycle():
    """Single collection cycle: discover → download → ingest."""
    state = load_state()
    log.info("Starting collection cycle")

    products = discover_products(lookback_minutes=30)
    if not products:
        log.info("No new products found")
        save_state(state)
        return

    # Filter already-processed products
    last_time = state.get("last_product_time")
    new_products = products  # In production, filter by last_time

    for product in new_products:
        product_id = product["id"]
        log.info(f"Processing product: {product_id}")

        body_path = download_product(product_id)
        if body_path:
            # Call ingester
            from ingester import ingest_nc_file
            result = ingest_nc_file(str(body_path), product_id)
            if result:
                state["last_product_time"] = product.get(
                    "sensing_end", datetime.now(timezone.utc).isoformat()
                )
                log.info(f"Successfully ingested {product_id}: {result['flash_count']} flashes")
            else:
                log.error(f"Ingestion failed for {product_id}")
        else:
            log.warning(f"Download failed for {product_id}, skipping")

    save_state(state)
    log.info("Collection cycle complete")


def main():
    """Entry point — run once or loop based on INGESTION_INTERVAL_SEC."""
    if not CONSUMER_KEY or not CONSUMER_SECRET:
        log.warning(
            "EUMETSAT credentials not configured. "
            "Set EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET in .env"
        )

    if "--once" in sys.argv:
        run_collection_cycle()
        return

    interval = int(os.getenv("INGESTION_INTERVAL_SEC", "120"))
    max_consecutive_failures = int(os.getenv("MAX_CONSECUTIVE_FAILURES", "10"))
    log.info(f"Starting collector loop (interval: {interval}s, max_failures: {max_consecutive_failures})")

    consecutive_failures = 0

    while True:
        try:
            run_collection_cycle()
            consecutive_failures = 0
        except Exception as e:
            consecutive_failures += 1
            log.error(f"Collection cycle error ({consecutive_failures}/{max_consecutive_failures}): {e}")
            if consecutive_failures >= max_consecutive_failures:
                log.critical(
                    f"Exceeded {max_consecutive_failures} consecutive failures — "
                    "exiting so Fly.io can restart the process."
                )
                sys.exit(1)
        time.sleep(interval)


if __name__ == "__main__":
    main()
