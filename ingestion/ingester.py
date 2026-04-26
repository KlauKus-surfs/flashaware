"""
EUMETSAT MTG LI-2-LFL NetCDF Ingester
Parses BODY .nc files and bulk-inserts flash events into PostgreSQL.
Also parses TRAIL .nc files for QC metrics.
"""

import os
import sys
import time
import logging
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("ingester")

DATABASE_URL = os.getenv("DATABASE_URL")
DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", "5432")),
    "user": os.getenv("POSTGRES_USER", "lightning"),
    "password": os.getenv("POSTGRES_PASSWORD", "lightning_dev"),
    "dbname": os.getenv("POSTGRES_DB", "lightning_risk"),
}

DURATION_CLAMP_MS = 600  # P95 clamp threshold


def get_db_connection():
    """Create a new database connection. Uses DATABASE_URL if available (Fly.io), else individual vars."""
    if DATABASE_URL:
        return psycopg2.connect(DATABASE_URL)
    return psycopg2.connect(**DB_CONFIG)


def parse_body_nc(filepath: str) -> Optional[list[dict]]:
    """
    Parse a LI-2-LFL CHK-BODY NetCDF file.
    Returns list of flash event dicts ready for DB insertion.
    netCDF4 auto-applies scale_factor and add_offset.
    """
    try:
        import netCDF4 as nc
    except ImportError:
        log.error("netCDF4 not installed. Run: pip install netCDF4")
        return None

    try:
        ds = nc.Dataset(filepath, "r")
    except Exception as e:
        log.error(f"Failed to open {filepath}: {e}")
        return None

    try:
        n_flashes = len(ds.dimensions.get("flashes", []))
        if n_flashes == 0:
            log.warning(f"No flashes in {filepath}")
            ds.close()
            return []

        log.info(f"Parsing {n_flashes} flashes from {Path(filepath).name}")

        # Read variables (auto-scaled by netCDF4)
        flash_time = nc.num2date(
            ds.variables["flash_time"][:],
            units=ds.variables["flash_time"].units,
            calendar=getattr(ds.variables["flash_time"], "calendar", "standard"),
        )
        latitude = ds.variables["latitude"][:]
        longitude = ds.variables["longitude"][:]
        radiance = ds.variables["radiance"][:] if "radiance" in ds.variables else np.full(n_flashes, np.nan)
        flash_id = ds.variables["flash_id"][:] if "flash_id" in ds.variables else np.arange(n_flashes)
        num_groups = ds.variables["number_of_groups"][:] if "number_of_groups" in ds.variables else np.zeros(n_flashes)
        num_events = ds.variables["number_of_events"][:] if "number_of_events" in ds.variables else np.zeros(n_flashes)
        duration_ms = ds.variables["flash_duration"][:] if "flash_duration" in ds.variables else np.zeros(n_flashes)
        footprint = ds.variables["flash_footprint"][:] if "flash_footprint" in ds.variables else np.full(n_flashes, np.nan)
        filter_conf = ds.variables["flash_filter_confidence"][:] if "flash_filter_confidence" in ds.variables else np.full(n_flashes, np.nan)

        # Handle truncated flashes
        truncated_indices = set()
        if "truncated_flashes" in ds.variables:
            trunc_var = ds.variables["truncated_flashes"][:]
            if hasattr(trunc_var, "compressed"):
                truncated_indices = set(trunc_var.compressed().tolist())
            else:
                truncated_indices = set(trunc_var.tolist())

        ds.close()

        flashes = []
        for i in range(n_flashes):
            lat_val = float(latitude[i])
            lon_val = float(longitude[i])

            # Skip fill values / invalid coordinates
            if np.isnan(lat_val) or np.isnan(lon_val):
                continue
            if abs(lat_val) > 90 or abs(lon_val) > 180:
                continue

            dur = int(duration_ms[i]) if not np.isnan(duration_ms[i]) else None
            dur_clamped = min(dur, DURATION_CLAMP_MS) if dur is not None else None

            ft = flash_time[i]
            if hasattr(ft, "isoformat"):
                flash_time_utc = ft.isoformat()
            else:
                flash_time_utc = str(ft)

            flashes.append({
                "flash_id": int(flash_id[i]),
                "flash_time_utc": flash_time_utc,
                "latitude": lat_val,
                "longitude": lon_val,
                "radiance": float(radiance[i]) if not np.isnan(radiance[i]) else None,
                "duration_ms": dur,
                "duration_clamped_ms": dur_clamped,
                "footprint": float(footprint[i]) if not np.isnan(footprint[i]) else None,
                "num_groups": int(num_groups[i]),
                "num_events": int(num_events[i]),
                "filter_confidence": float(filter_conf[i]) if not np.isnan(filter_conf[i]) else None,
                "is_truncated": i in truncated_indices,
            })

        log.info(f"Parsed {len(flashes)} valid flashes (skipped {n_flashes - len(flashes)} invalid)")
        return flashes

    except Exception as e:
        log.error(f"Error parsing {filepath}: {e}", exc_info=True)
        ds.close()
        return None


def parse_trail_nc(filepath: str) -> Optional[dict]:
    """
    Parse a LI-2-LFL CHK-TRAIL NetCDF file for QC metrics.
    Returns summary dict for ingestion_log.trail_data.
    """
    try:
        import netCDF4 as nc
    except ImportError:
        return None

    try:
        ds = nc.Dataset(filepath, "r")
    except Exception:
        return None

    try:
        trail_data = {}

        if "l2_flashes_per_second" in ds.variables:
            fps = ds.variables["l2_flashes_per_second"][:]
            trail_data["avg_flashes_per_second"] = float(np.nanmean(fps))
            trail_data["max_flashes_per_second"] = float(np.nanmax(fps))
            trail_data["total_seconds"] = len(fps)

        if "flash_rejection_rate" in ds.variables:
            rr = ds.variables["flash_rejection_rate"][:]
            trail_data["flash_rejection_rate"] = float(np.nanmean(rr))

        if "l2_fragmented_flash_per_second" in ds.variables:
            frag = ds.variables["l2_fragmented_flash_per_second"][:]
            trail_data["avg_fragmented_per_second"] = float(np.nanmean(frag))

        if "flash_duration_histogram" in ds.variables:
            hist = ds.variables["flash_duration_histogram"][:]
            trail_data["duration_histogram"] = hist.tolist()

        if "flash_duration_ranges" in ds.variables:
            ranges = ds.variables["flash_duration_ranges"][:]
            trail_data["duration_ranges"] = ranges.tolist()

        ds.close()
        return trail_data

    except Exception as e:
        log.warning(f"Error parsing TRAIL file: {e}")
        try:
            ds.close()
        except Exception:
            pass
        return None


def determine_qc_status(flash_count: int, trail_data: Optional[dict]) -> str:
    """Determine QC status based on flash count and TRAIL metrics."""
    if flash_count == 0:
        return "LOW_COUNT"

    if trail_data:
        rejection_rate = trail_data.get("flash_rejection_rate", 0)
        if rejection_rate > 90:
            return "HIGH_REJECTION"

        avg_fps = trail_data.get("avg_flashes_per_second", 0)
        if avg_fps == 0:
            return "LOW_COUNT"

    return "OK"


def bulk_insert_flashes(flashes: list[dict], product_id: str) -> int:
    """Bulk insert flash events into PostgreSQL using execute_values."""
    if not flashes:
        return 0

    conn = get_db_connection()
    try:
        cur = conn.cursor()

        values = []
        for f in flashes:
            wkt = f"SRID=4326;POINT({f['longitude']} {f['latitude']})"
            values.append((
                f["flash_id"],
                f["flash_time_utc"],
                wkt,
                f["latitude"],
                f["longitude"],
                f["radiance"],
                f["duration_ms"],
                f["duration_clamped_ms"],
                f["footprint"],
                f["num_groups"],
                f["num_events"],
                f["filter_confidence"],
                f["is_truncated"],
                product_id,
            ))

        # ON CONFLICT DO NOTHING relies on uq_flash_events_product_flash —
        # see server/migrate.ts. Without that index re-ingesting an overlapping
        # batch would double-count flashes and trigger phantom STOPs.
        sql = """
            INSERT INTO flash_events
                (flash_id, flash_time_utc, geom, latitude, longitude, radiance,
                 duration_ms, duration_clamped_ms, footprint, num_groups,
                 num_events, filter_confidence, is_truncated, product_id)
            VALUES %s
            ON CONFLICT (product_id, flash_id) DO NOTHING
        """

        psycopg2.extras.execute_values(
            cur, sql, values,
            template="(%s, %s, ST_GeomFromEWKT(%s), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            page_size=500,
        )

        conn.commit()
        inserted = cur.rowcount
        cur.close()
        log.info(f"Inserted {inserted} flashes for product {product_id}")
        return inserted

    except Exception as e:
        conn.rollback()
        log.error(f"Bulk insert failed: {e}", exc_info=True)
        return 0
    finally:
        conn.close()


def log_ingestion(
    product_id: str,
    product_time_start: Optional[str],
    product_time_end: Optional[str],
    flash_count: int,
    file_size: int,
    download_ms: int,
    parse_ms: int,
    qc_status: str,
    trail_data: Optional[dict],
):
    """Log ingestion result to ingestion_log table."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO ingestion_log
                (product_id, product_time_start, product_time_end, flash_count,
                 file_size_bytes, download_ms, parse_ms, qc_status, trail_data)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (product_id) DO UPDATE SET
                 flash_count = EXCLUDED.flash_count,
                 qc_status = EXCLUDED.qc_status,
                 trail_data = EXCLUDED.trail_data,
                 ingested_at = NOW()""",
            [
                product_id,
                product_time_start,
                product_time_end,
                flash_count,
                file_size,
                download_ms,
                parse_ms,
                qc_status,
                json.dumps(trail_data) if trail_data else None,
            ],
        )
        conn.commit()
        cur.close()
    except Exception as e:
        conn.rollback()
        log.error(f"Failed to log ingestion: {e}")
    finally:
        conn.close()


def ingest_nc_file(body_path: str, product_id: str, trail_path: str = None) -> Optional[dict]:
    """
    Main ingestion entry point.
    Parses a BODY .nc file, optionally a TRAIL .nc, inserts to DB, logs result.
    Returns summary dict or None on failure.
    """
    file_size = os.path.getsize(body_path) if os.path.exists(body_path) else 0

    # Parse BODY
    t0 = time.time()
    flashes = parse_body_nc(body_path)
    parse_ms = int((time.time() - t0) * 1000)

    if flashes is None:
        log_ingestion(product_id, None, None, 0, file_size, 0, parse_ms, "ERROR", None)
        return None

    # Parse TRAIL (optional)
    trail_data = None
    if trail_path and os.path.exists(trail_path):
        trail_data = parse_trail_nc(trail_path)

    # Determine time range from flashes
    product_time_start = None
    product_time_end = None
    if flashes:
        times = sorted([f["flash_time_utc"] for f in flashes])
        product_time_start = times[0]
        product_time_end = times[-1]

    # Insert to DB
    t0 = time.time()
    inserted = bulk_insert_flashes(flashes, product_id)
    insert_ms = int((time.time() - t0) * 1000)

    # QC check
    qc_status = determine_qc_status(len(flashes), trail_data)

    # Log
    log_ingestion(
        product_id=product_id,
        product_time_start=product_time_start,
        product_time_end=product_time_end,
        flash_count=inserted,
        file_size=file_size,
        download_ms=0,
        parse_ms=parse_ms,
        qc_status=qc_status,
        trail_data=trail_data,
    )

    result = {
        "product_id": product_id,
        "flash_count": inserted,
        "parse_ms": parse_ms,
        "insert_ms": insert_ms,
        "qc_status": qc_status,
    }

    log.info(f"Ingestion complete: {json.dumps(result)}")
    return result


def main():
    """CLI entry point for manual ingestion of .nc files."""
    if len(sys.argv) < 2:
        print("Usage: python ingester.py <body.nc> [trail.nc] [product_id]")
        print("  body.nc    — Path to CHK-BODY NetCDF file")
        print("  trail.nc   — Optional path to CHK-TRAIL NetCDF file")
        print("  product_id — Optional product identifier (defaults to filename)")
        sys.exit(1)

    body_path = sys.argv[1]
    trail_path = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else None
    product_id = sys.argv[3] if len(sys.argv) > 3 else Path(body_path).stem

    if not os.path.exists(body_path):
        log.error(f"File not found: {body_path}")
        sys.exit(1)

    result = ingest_nc_file(body_path, product_id, trail_path)
    if result:
        print(json.dumps(result, indent=2))
    else:
        log.error("Ingestion failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
