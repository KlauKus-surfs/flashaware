#!/usr/bin/env python3
"""
Backfill afa_pixels for the storm dates used by replay-demo locations.

Queries production for locations whose name matches 'Replay demo … YYYY-MM-DD',
parses the date, finds the actual storm window from existing flash_events,
pulls AFA products from EUMETSAT for that window, runs them through
parse_afa_nc_json.py, and inserts rows into afa_pixels (idempotent via the
existing ingestion_log table and the uq_afa_pixel unique index).

Usage:
  EUMETSAT_CONSUMER_KEY=... EUMETSAT_CONSUMER_SECRET=... \
  DATABASE_URL=postgres://... \
  python backfill_afa.py
"""

import os
import re
import sys
import json
import subprocess
import tempfile
import zipfile
from base64 import b64encode
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras
import requests

EUMETSAT_TOKEN = 'https://api.eumetsat.int/token'
EUMETSAT_SEARCH = 'https://api.eumetsat.int/data/search-products/1.0.0/os'
EUMETSAT_DL = 'https://api.eumetsat.int/data/download/1.0.0/collections'
COLLECTION = os.environ.get('EUMETSAT_AFA_COLLECTION_ID', 'EO:EUM:DAT:0687')
PARSER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parse_afa_nc_json.py')

DATE_RE = re.compile(r'\b(\d{4}-\d{2}-\d{2})\b')


def get_token() -> str:
    """Obtain EUMETSAT OAuth token using consumer credentials."""
    key = os.environ['EUMETSAT_CONSUMER_KEY']
    sec = os.environ['EUMETSAT_CONSUMER_SECRET']
    auth = b64encode(f'{key}:{sec}'.encode()).decode()
    r = requests.post(
        EUMETSAT_TOKEN,
        headers={'Authorization': f'Basic {auth}', 'Content-Type': 'application/x-www-form-urlencoded'},
        data='grant_type=client_credentials',
    )
    r.raise_for_status()
    return r.json()['access_token']


def find_targets(cur) -> list:
    """
    Find replay-demo locations with YYYY-MM-DD in their name.
    For each, determine the storm window from flash_events or use date +/- 1 day.
    Returns list of dicts with location_id, name, start, end (UTC).
    """
    cur.execute("""
      SELECT id, name FROM locations
       WHERE name ILIKE '%replay demo%' OR name ILIKE '%storm demo%'
    """)
    targets = []
    for row in cur.fetchall():
        m = DATE_RE.search(row['name'])
        if not m:
            print(f"skipping {row['name']!r}: no YYYY-MM-DD", file=sys.stderr)
            continue
        date = datetime.strptime(m.group(1), '%Y-%m-%d').replace(tzinfo=timezone.utc)
        cur.execute("""
          SELECT MIN(flash_time_utc) AS start, MAX(flash_time_utc) AS end
            FROM flash_events
           WHERE flash_time_utc::date = %s
        """, (date.date(),))
        r = cur.fetchone()
        if not r or not r['start']:
            start = date
            end = date + timedelta(days=1)
        else:
            start = r['start'] - timedelta(minutes=30)
            end = r['end'] + timedelta(minutes=30)
        targets.append({'location_id': row['id'], 'name': row['name'], 'start': start, 'end': end})
    return targets


def download_and_parse(token_box: dict, product_id: str, refresh_token) -> list:
    """
    Download a product from EUMETSAT as a zip, extract the .nc file,
    run parse_afa_nc_json.py on it, and return the pixel list.
    Returns empty list on any error (download, parse, unzip).
    Handles 401 by refreshing token and retrying once.
    """
    coll = requests.utils.quote(COLLECTION, safe='')
    pid = requests.utils.quote(product_id, safe='')
    dl = requests.get(f'{EUMETSAT_DL}/{coll}/products/{pid}', headers={'Authorization': f"Bearer {token_box['value']}"})
    if dl.status_code == 401:
        refresh_token()
        dl = requests.get(f'{EUMETSAT_DL}/{coll}/products/{pid}', headers={'Authorization': f"Bearer {token_box['value']}"})
    if dl.status_code != 200:
        return []
    with tempfile.TemporaryDirectory() as td:
        zpath = os.path.join(td, 'a.zip')
        with open(zpath, 'wb') as f:
            f.write(dl.content)
        nc_path = None
        try:
            with zipfile.ZipFile(zpath) as z:
                for n in z.namelist():
                    if n.endswith('.nc'):
                        z.extract(n, td)
                        nc_path = os.path.join(td, n)
                        break
        except zipfile.BadZipFile:
            nc_path = zpath
        if not nc_path:
            return []
        proc = subprocess.run([sys.executable, PARSER, nc_path], capture_output=True, text=True)
        if proc.returncode != 0:
            print(f'parser failed: {proc.stderr}', file=sys.stderr)
            return []
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError as e:
            print(f'JSON parse failed for {product_id}: {e}', file=sys.stderr)
            return []


def insert_pixels(cur, product_id: str, pixels: list) -> int:
    """
    Bulk insert AFA pixels for a product.
    Idempotent via uq_afa_pixel unique index (product_id, observed_at_utc, pixel_lat, pixel_lon).
    Returns number of rows inserted (may be 0 if all conflict).
    """
    if not pixels:
        return 0
    psycopg2.extras.execute_values(
        cur,
        """INSERT INTO afa_pixels (product_id, observed_at_utc, pixel_lat, pixel_lon, geom, flash_count)
           VALUES %s ON CONFLICT DO NOTHING""",
        [(product_id, p['observed_at_utc'], p['pixel_lat'], p['pixel_lon'],
          f"SRID=4326;{p['geom_wkt']}", p['flash_count']) for p in pixels],
        template="(%s, %s, %s, %s, ST_GeomFromEWKT(%s), %s)",
    )
    return cur.rowcount


def main() -> int:
    """
    Main backfill flow:
    1. Connect to production DB.
    2. Get EUMETSAT token.
    3. Find all replay-demo locations and their storm windows.
    4. For each window, search EUMETSAT for AFA products.
    5. For each product, check ingestion_log to skip duplicates.
    6. Download, parse, and insert pixels.
    7. Log to ingestion_log (idempotent via ON CONFLICT).
    """
    conn = psycopg2.connect(os.environ['DATABASE_URL'], cursor_factory=psycopg2.extras.DictCursor)
    cur = conn.cursor()
    token_box = {'value': get_token()}

    def refresh_token():
        token_box['value'] = get_token()
        return token_box['value']

    targets = find_targets(cur)
    print(f'targets: {len(targets)}')
    for t in targets:
        print(f"  {t['name']}: {t['start'].isoformat()} -> {t['end'].isoformat()}")

    for t in targets:
        r = requests.get(
            EUMETSAT_SEARCH,
            headers={'Authorization': f"Bearer {token_box['value']}"},
            params={
                'pi': COLLECTION,
                'dtstart': t['start'].isoformat(),
                'dtend': t['end'].isoformat(),
                'format': 'json',
                'c': '500',
            },
        )
        r.raise_for_status()
        features = r.json().get('features', [])
        print(f"  {t['name']}: {len(features)} products")
        for feat in features:
            pid = feat['id']
            cur.execute('SELECT 1 FROM ingestion_log WHERE product_id = %s', (pid,))
            if cur.fetchone():
                continue
            pixels = download_and_parse(token_box, pid, refresh_token)
            inserted = insert_pixels(cur, pid, pixels)
            cur.execute(
                """INSERT INTO ingestion_log
                   (product_id, product_time_start, product_time_end, flash_count, ingested_at, qc_status)
                   VALUES (%s, %s, %s, %s, NOW(), %s) ON CONFLICT DO NOTHING""",
                (pid, t['start'], t['end'], inserted, 'OK' if inserted else 'LOW_COUNT'),
            )
            conn.commit()
    return 0


if __name__ == '__main__':
    sys.exit(main())
