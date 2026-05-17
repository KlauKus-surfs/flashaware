"""
Synthetic AFA netCDF generator that matches the REAL EO:EUM:DAT:0687
structure: sparse pixel list in MTG geostationary projection, NOT a 2D
lat/lon grid.

Pixels are chosen by computing the exact MTG-I1 geostationary scan angles
that correspond to known Southern Africa cities (verified via the forward
transform used in the production fixture validation step), plus two pixels
used for filter testing:
  - one whose lat projects outside the SA bbox (Nairobi, ~-1.3 deg N)
  - one with zero flash count (filtered out by parser)

The net result: 6 pixels produce rows (5 JNB cluster + 1 Durban), 1 is
outside SA bbox, 1 has zero count — giving the parser's filter logic
something to exercise.

netCDF4-python auto-applies scale_factor/add_offset on write when those
attributes are set, so we write physical radian values directly and the
library handles the int16 encoding.
"""
import netCDF4 as nc
import numpy as np
import os

OUT = os.path.join(os.path.dirname(__file__), 'afa_sample.nc')

# Real file scale/offset for x and y variables (from EUMETSAT EO:EUM:DAT:0687)
X_SCALE = -5.58871526031607e-05
X_OFFSET = 0.155617776423501
Y_SCALE = 5.58871526031607e-05
Y_OFFSET = -0.155617776423501

# Scan angles in radians computed from the MTG-I1 forward geostationary transform.
# x = azimuth (positive east), y = elevation (negative = south of equator).
# These were derived from the inverse of geos_to_latlon() for the listed cities.
pixel_radians = [
    (0.0723228, -0.0750882),  # JNB-1 ~(-26.2, 28.0) Johannesburg
    (0.0724093, -0.0755915),  # JNB-2 ~(-26.4, 28.1)
    (0.0718144, -0.0761259),  # JNB-3 ~(-26.6, 27.9)
    (0.0718673, -0.0751096),  # JNB-4 ~(-26.2, 27.8)
    (0.0728622, -0.0755699),  # JNB-5 ~(-26.4, 28.3)
    (0.0758063, -0.0840350),  # Durban ~(-29.9, 30.9)  — inside SA bbox
    (0.1027084, -0.0038581),  # Nairobi ~(-1.3, 36.8) — OUTSIDE SA bbox (lat > -18)
    (0.0722528, -0.0753454),  # JNB-zero ~(-26.3, 28.0) — zero flash count, filtered
]
counts = [3, 5, 2, 4, 7, 1, 1, 0]

n_pixels = len(pixel_radians)
n_accumulations = 20

ds = nc.Dataset(OUT, 'w', format='NETCDF4')
ds.createDimension('pixels', n_pixels)
ds.createDimension('accumulations', n_accumulations)
ds.createDimension('enumtype_dim', 1)
ds.createDimension('auxiliary_dataset', 1)

# Write physical radian values; netCDF4 auto-encodes to int16 via scale/offset
v_x = ds.createVariable('x', 'i2', ('pixels',))
v_x.scale_factor = X_SCALE
v_x.add_offset = X_OFFSET
v_x.long_name = 'azimuth angle encoded as column'
v_x.units = 'radian'
v_x[:] = np.array([r[0] for r in pixel_radians], dtype=np.float64)

v_y = ds.createVariable('y', 'i2', ('pixels',))
v_y.scale_factor = Y_SCALE
v_y.add_offset = Y_OFFSET
v_y.long_name = 'elevation angle encoded as row'
v_y.units = 'radian'
v_y[:] = np.array([r[1] for r in pixel_radians], dtype=np.float64)

v_afa = ds.createVariable('accumulated_flash_area', 'u4', ('pixels',))
v_afa.long_name = 'Number of contributing unique flashes to each pixel'
v_afa[:] = np.array(counts, dtype=np.uint32)

v_t = ds.createVariable('accumulation_start_times', 'f8', ('accumulations',))
v_t.units = 'seconds since 2000-01-01 00:00:00.0'
v_t.calendar = 'standard'
# 2025-05-15T12:34:30 UTC = unix 1747318470; epoch offset 2000-01-01 = 946684800
# -> 1747318470 - 946684800 = 800633670 seconds since 2000-01-01
base = 800633670.0
v_t[:] = np.array([base + 1.5 * i for i in range(n_accumulations)], dtype=np.float64)

# Optional projection scalar (parser doesn't read it, included for completeness)
v_proj = ds.createVariable('mtg_geos_projection', 'i4')
v_proj.long_name = 'MTG geostationary projection'
v_proj.grid_mapping_name = 'geostationary'
v_proj.perspective_point_height = 35786400.0
v_proj.semi_major_axis = 6378137.0
v_proj.semi_minor_axis = 6356752.31424518
v_proj.inverse_flattening = 298.257223563

ds.close()
print('wrote', OUT, 'with', n_pixels, 'pixels')
print('expected parser output: 6 rows (5 JNB + 1 Durban) -- Nairobi outside SA, zero-count filtered')
