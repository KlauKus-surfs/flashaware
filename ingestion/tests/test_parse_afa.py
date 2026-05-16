import json
import subprocess
import os
import sys

THIS_DIR = os.path.dirname(__file__)
PARSER = os.path.join(THIS_DIR, '..', 'parse_afa_nc_json.py')
FIXTURE = os.path.join(THIS_DIR, 'fixtures', 'afa_sample.nc')


def run_parser():
    proc = subprocess.run(
        [sys.executable, PARSER, FIXTURE],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def test_extracts_only_nonzero_pixels():
    rows = run_parser()
    # 3x3 lit block = 9 pixels with flash_count > 0
    assert len(rows) == 9


def test_pixel_shape():
    rows = run_parser()
    sample = rows[0]
    assert set(sample.keys()) == {
        'observed_at_utc', 'pixel_lat', 'pixel_lon', 'flash_count', 'geom_wkt'
    }
    assert sample['flash_count'] >= 1
    assert sample['geom_wkt'].startswith('POLYGON((')


def test_centre_pixel_has_highest_count():
    rows = run_parser()
    counts = sorted([r['flash_count'] for r in rows])
    # Distribution from fixture: 1,1,1,1,2,2,2,2,5
    assert counts == [1, 1, 1, 1, 2, 2, 2, 2, 5]


def test_observed_at_is_iso8601_utc():
    rows = run_parser()
    ts = rows[0]['observed_at_utc']
    # Must end in Z (and only Z — no '+00:00Z' nonsense)
    assert ts.endswith('Z'), f"timestamp should end with Z, got {ts!r}"
    assert '+' not in ts, f"timestamp should not have +offset, got {ts!r}"
    # ISO 8601 sanity: matches YYYY-MM-DDTHH:MM:SS(.fff)?Z
    import re
    assert re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$', ts), \
        f"not ISO 8601 UTC: {ts!r}"
