import json
import subprocess
import os
import sys
import re

THIS_DIR = os.path.dirname(__file__)
PARSER = os.path.join(THIS_DIR, '..', 'parse_afa_nc_json.py')
FIXTURE = os.path.join(THIS_DIR, 'fixtures', 'afa_sample.nc')


def run_parser():
    proc = subprocess.run(
        [sys.executable, PARSER, FIXTURE],
        capture_output=True, text=True, check=True,
    )
    return json.loads(proc.stdout)


def test_excludes_zero_flash_pixels():
    rows = run_parser()
    assert all(r['flash_count'] >= 1 for r in rows), \
        f"zero-count pixel made it through: {rows}"


def test_excludes_outside_sa_bbox():
    rows = run_parser()
    for r in rows:
        assert -36.0 <= r['pixel_lat'] <= -18.0, f"lat outside SA: {r}"
        assert 14.0 <= r['pixel_lon'] <= 38.0, f"lon outside SA: {r}"


def test_pixel_shape():
    rows = run_parser()
    if not rows:
        return  # no SA rows is OK depending on fixture projection
    sample = rows[0]
    assert set(sample.keys()) == {
        'observed_at_utc', 'pixel_lat', 'pixel_lon', 'flash_count', 'geom_wkt'
    }
    assert sample['geom_wkt'].startswith('POLYGON((')


def test_observed_at_is_iso8601_utc():
    rows = run_parser()
    if not rows:
        return
    ts = rows[0]['observed_at_utc']
    assert ts.endswith('Z'), f"timestamp should end with Z, got {ts!r}"
    assert '+' not in ts, f"timestamp should not have +offset, got {ts!r}"
    assert re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$', ts), \
        f"not ISO 8601 UTC: {ts!r}"


def test_at_least_some_rows():
    """Sanity: the synthetic fixture should produce at least 1 row inside SA."""
    rows = run_parser()
    assert len(rows) >= 1, f"expected at least 1 row, got {rows}"
