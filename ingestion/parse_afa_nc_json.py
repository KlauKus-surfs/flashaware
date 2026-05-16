#!/usr/bin/env python3
"""
NetCDF -> JSON parser for LI-2-AFA (Accumulated Flash Area).
Outputs JSON array of one object per non-zero 2 km pixel to stdout.

Variable names below were verified against a real EO:EUM:DAT:0687 product
specification. Step 2.1 (live API discovery) was SKIPPED on 2026-05-15
because EUMETSAT_CONSUMER_KEY was not set in the environment.
Assumed variable names:
  - accumulated_flash_area  (y, x)  int32  units=count
  - latitude                (y,)    float32
  - longitude               (x,)    float32
  - time                    (time,) float64 units="seconds since 1970-01-01 00:00:00"

Update both this file AND tests/fixtures/make_afa_fixture.py together if
EUMETSAT changes the format or if live inspection reveals different names.

Usage: python parse_afa_nc_json.py <body.nc>
"""

import sys
import json
import numpy as np

# Southern Africa bounding box — match the API ingester's clip
SA = {'south': -36.0, 'north': -18.0, 'west': 14.0, 'east': 38.0}

# 2 km pixel half-extent in degrees. Lat is ~constant; lon scales by cos(lat).
LAT_HALF = 1.0 / 111.0  # ~0.009 deg = ~1 km, so half a 2 km cell is ~0.009


def cell_polygon_wkt(lat: float, lon: float) -> str:
    lat_h = LAT_HALF
    lon_h = LAT_HALF / max(np.cos(np.radians(lat)), 0.1)
    s, n = lat - lat_h, lat + lat_h
    w, e = lon - lon_h, lon + lon_h
    return f"POLYGON(({w:.6f} {s:.6f}, {e:.6f} {s:.6f}, {e:.6f} {n:.6f}, {w:.6f} {n:.6f}, {w:.6f} {s:.6f}))"


def parse(filepath: str) -> None:
    try:
        import netCDF4 as nc
    except ImportError:
        print(json.dumps({"error": "netCDF4 not installed"}), file=sys.stderr)
        sys.exit(1)

    try:
        ds = nc.Dataset(filepath, "r")
    except Exception as e:
        print(json.dumps({"error": f"Failed to open {filepath}: {e}"}), file=sys.stderr)
        sys.exit(1)

    try:
        afa = ds.variables["accumulated_flash_area"][:]
        if hasattr(afa, 'filled'):
            afa = afa.filled(0)
        lats = ds.variables["latitude"][:]
        lons = ds.variables["longitude"][:]

        time_var = ds.variables["time"]
        time_val = nc.num2date(
            time_var[:][0],
            units=time_var.units,
            calendar=getattr(time_var, "calendar", "standard"),
        )
        iso = time_val.isoformat()
        if iso.endswith("Z"):
            observed_at = iso
        elif iso.endswith("+00:00"):
            observed_at = iso[:-len("+00:00")] + "Z"
        else:
            observed_at = iso + "Z"

        ds.close()

        rows = []
        for yi in range(afa.shape[0]):
            for xi in range(afa.shape[1]):
                count = int(afa[yi, xi])
                if count <= 0:
                    continue
                lat = float(lats[yi])
                lon = float(lons[xi])
                if not (SA["south"] <= lat <= SA["north"] and SA["west"] <= lon <= SA["east"]):
                    continue
                rows.append({
                    "observed_at_utc": observed_at,
                    "pixel_lat": round(lat, 5),
                    "pixel_lon": round(lon, 5),
                    "flash_count": count,
                    "geom_wkt": cell_polygon_wkt(lat, lon),
                })

        json.dump(rows, sys.stdout)

    except Exception as e:
        try:
            ds.close()
        except Exception:
            pass
        print(json.dumps({"error": f"Parse error: {e}"}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python parse_afa_nc_json.py <body.nc>", file=sys.stderr)
        sys.exit(1)
    parse(sys.argv[1])
