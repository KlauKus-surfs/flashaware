#!/usr/bin/env python3
"""
Lightweight NetCDF → JSON parser for LI-2-LFL flash data.
Outputs JSON array of flash objects to stdout. No PostgreSQL dependency.
Usage: python parse_nc_json.py <body.nc>
"""

import sys
import json
import numpy as np

def parse(filepath):
    try:
        import netCDF4 as nc
    except ImportError:
        print(json.dumps({"error": "netCDF4 not installed. Run: pip install netCDF4"}), file=sys.stderr)
        sys.exit(1)

    try:
        ds = nc.Dataset(filepath, "r")
    except Exception as e:
        print(json.dumps({"error": f"Failed to open {filepath}: {str(e)}"}), file=sys.stderr)
        sys.exit(1)

    try:
        n_flashes = len(ds.dimensions.get("flashes", []))
        if n_flashes == 0:
            ds.close()
            json.dump([], sys.stdout)
            return

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

        truncated_indices = set()
        if "truncated_flashes" in ds.variables:
            trunc_var = ds.variables["truncated_flashes"][:]
            if hasattr(trunc_var, "compressed"):
                truncated_indices = set(trunc_var.compressed().tolist())
            else:
                truncated_indices = set(trunc_var.tolist())

        ds.close()

        DURATION_CLAMP_MS = 600

        def safe_float(val, decimals=3):
            """Convert to float, returning None for NaN/Inf."""
            try:
                v = float(val)
                if np.isnan(v) or np.isinf(v):
                    return None
                return round(v, decimals)
            except (ValueError, TypeError):
                return None

        flashes = []
        for i in range(n_flashes):
            lat_val = float(latitude[i])
            lon_val = float(longitude[i])
            if np.isnan(lat_val) or np.isnan(lon_val):
                continue
            if abs(lat_val) > 90 or abs(lon_val) > 180:
                continue

            dur = int(duration_ms[i]) if not np.isnan(duration_ms[i]) else None
            dur_clamped = min(dur, DURATION_CLAMP_MS) if dur is not None else None

            ft = flash_time[i]
            flash_time_utc = ft.isoformat() if hasattr(ft, "isoformat") else str(ft)

            flashes.append({
                "flash_id": int(flash_id[i]),
                "flash_time_utc": flash_time_utc,
                "latitude": round(lat_val, 6),
                "longitude": round(lon_val, 6),
                "radiance": safe_float(radiance[i], 3),
                "duration_ms": dur,
                "duration_clamped_ms": dur_clamped,
                "footprint": safe_float(footprint[i], 1),
                "num_groups": int(num_groups[i]),
                "num_events": int(num_events[i]),
                "filter_confidence": safe_float(filter_conf[i], 3),
                "is_truncated": i in truncated_indices,
            })

        json.dump(flashes, sys.stdout)

    except Exception as e:
        try:
            ds.close()
        except Exception:
            pass
        print(json.dumps({"error": f"Parse error: {str(e)}"}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python parse_nc_json.py <body.nc>", file=sys.stderr)
        sys.exit(1)
    parse(sys.argv[1])
