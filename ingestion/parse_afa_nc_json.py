#!/usr/bin/env python3
"""
NetCDF -> JSON parser for LI-2-AFA (Accumulated Flash Area), MTG-I1.

Inputs: a CHK-BODY .nc file with a sparse pixel list in geostationary
projection. Variables required: x, y (scan angles in radians),
accumulated_flash_area (uint32), accumulation_start_times (seconds since
2000-01-01), and the mtg_geos_projection scalar with projection attrs.

Outputs JSON array to stdout, one object per non-zero pixel inside the
Southern Africa bbox. Fields:
  observed_at_utc (ISO 8601 UTC, ends with 'Z')
  pixel_lat       (degrees, 5 dp)
  pixel_lon       (degrees, 5 dp)
  flash_count     (int)
  geom_wkt        (POLYGON((...)) with 4 corners + close)

Usage: python parse_afa_nc_json.py <body.nc>
"""

import sys
import json
import numpy as np

SA = {'south': -36.0, 'north': -18.0, 'west': 14.0, 'east': 38.0}

# MTG-I1 geostationary projection constants
H_PERSPECTIVE = 35786400.0   # m, perspective_point_height
A = 6378137.0                # m, semi_major_axis (WGS84)
B = 6356752.31424518         # m, semi_minor_axis (WGS84)
SUB_LON = 0.0                # rad, MTG-I1 at 0 deg E


def geos_to_latlon(x_rad, y_rad):
    """Vectorised geostationary scan angle -> WGS84 (degrees).
    Returns (lat_deg, lon_deg, valid_mask) where valid_mask is False for
    points outside the visible disc.
    """
    H = H_PERSPECTIVE + A
    cos_x = np.cos(x_rad); sin_x = np.sin(x_rad)
    cos_y = np.cos(y_rad); sin_y = np.sin(y_rad)
    a2_b2 = (A * A) / (B * B)

    inner = (H * cos_x * cos_y) ** 2 - (cos_y ** 2 + a2_b2 * sin_y ** 2) * (H ** 2 - A ** 2)
    valid = inner >= 0
    inner_safe = np.where(valid, inner, 0.0)
    denom = cos_y ** 2 + a2_b2 * sin_y ** 2
    sd = (H * cos_x * cos_y - np.sqrt(inner_safe)) / denom

    s1 = H - sd * cos_x * cos_y
    s2 = sd * sin_x * cos_y
    s3 = sd * sin_y
    sxy = np.sqrt(s1 ** 2 + s2 ** 2)

    lon = np.arctan2(s2, s1) + SUB_LON
    lat = np.arctan(a2_b2 * s3 / sxy)
    return np.degrees(lat), np.degrees(lon), valid


# Half-pixel step in radians (from the scale_factor of x/y — ~2 km at sub-satellite)
HALF_STEP_RAD = 5.58871526031607e-05 / 2


def cell_polygon_wkt(x_rad, y_rad):
    """Build a 4-corner polygon in lat/lon by projecting the cell corners
    through the geostationary transform."""
    h = HALF_STEP_RAD
    cxs = np.array([x_rad - h, x_rad + h, x_rad + h, x_rad - h, x_rad - h])
    cys = np.array([y_rad - h, y_rad - h, y_rad + h, y_rad + h, y_rad - h])
    lats, lons, valid = geos_to_latlon(cxs, cys)
    if not valid.all():
        return None
    pts = ', '.join(f'{lon:.6f} {lat:.6f}' for lon, lat in zip(lons, lats))
    return f'POLYGON(({pts}))'


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
        x = ds.variables["x"][:]
        y = ds.variables["y"][:]
        afa = ds.variables["accumulated_flash_area"][:]
        t_var = ds.variables["accumulation_start_times"]
        t0_val = float(np.asarray(t_var[:])[0])
        time_obj = nc.num2date(t0_val, units=t_var.units,
                               calendar=getattr(t_var, "calendar", "standard"))
        iso = time_obj.isoformat()
        if iso.endswith("Z"):
            observed_at = iso
        elif iso.endswith("+00:00"):
            observed_at = iso[:-len("+00:00")] + "Z"
        else:
            observed_at = iso + "Z"
        ds.close()

        # Strip masks if present
        if hasattr(x, "filled"):    x = x.filled(np.nan)
        if hasattr(y, "filled"):    y = y.filled(np.nan)
        if hasattr(afa, "filled"):  afa = afa.filled(0)

        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        afa = np.asarray(afa, dtype=np.int64)

        # Project everything in one shot
        lat_deg, lon_deg, valid = geos_to_latlon(x, y)

        # Filter to non-zero, valid projection, and SA bbox
        mask = (
            valid
            & (afa > 0)
            & (lat_deg >= SA["south"]) & (lat_deg <= SA["north"])
            & (lon_deg >= SA["west"])  & (lon_deg <= SA["east"])
        )
        idx = np.where(mask)[0]

        out = []
        for i in idx:
            wkt = cell_polygon_wkt(x[i], y[i])
            if wkt is None:
                continue
            out.append({
                "observed_at_utc": observed_at,
                "pixel_lat": round(float(lat_deg[i]), 5),
                "pixel_lon": round(float(lon_deg[i]), 5),
                "flash_count": int(afa[i]),
                "geom_wkt": wkt,
            })

        json.dump(out, sys.stdout)
    except Exception as e:
        try: ds.close()
        except Exception: pass
        print(json.dumps({"error": f"Parse error: {e}"}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python parse_afa_nc_json.py <body.nc>", file=sys.stderr)
        sys.exit(1)
    parse(sys.argv[1])
