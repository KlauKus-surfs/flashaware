"""
Generate a synthetic AFA netCDF for parser unit tests. Run once; checks in
ingestion/tests/fixtures/afa_sample.nc.

Mirrors the variable names and dimensions observed in the real LI-2-AFA
product (see comment block in parse_afa_nc_json.py for the spec inspection
that informed these).

Step 2.1 was SKIPPED (no EUMETSAT credentials in environment).
Variable names used: accumulated_flash_area, latitude, longitude, time
— these are the assumed names; update both this file AND parse_afa_nc_json.py
together if real data reveals different names.
"""
import netCDF4 as nc
import numpy as np
import os

OUT = os.path.join(os.path.dirname(__file__), 'afa_sample.nc')

# 5x5 grid centred on Johannesburg with a single 'lit' 3x3 block
lats = np.linspace(-26.30, -26.10, 5).astype(np.float32)
lons = np.linspace(27.95, 28.15, 5).astype(np.float32)
afa = np.zeros((5, 5), dtype=np.int32)
afa[1:4, 1:4] = [[1, 2, 1],
                 [2, 5, 2],
                 [1, 2, 1]]

ds = nc.Dataset(OUT, 'w', format='NETCDF4')
ds.createDimension('y', 5)
ds.createDimension('x', 5)
ds.createDimension('time', 1)

v_lat = ds.createVariable('latitude', 'f4', ('y',))
v_lon = ds.createVariable('longitude', 'f4', ('x',))
v_afa = ds.createVariable('accumulated_flash_area', 'i4', ('y', 'x'))
v_afa.units = 'count'
v_time = ds.createVariable('time', 'f8', ('time',))
v_time.units = 'seconds since 1970-01-01 00:00:00'
v_time.calendar = 'standard'

v_lat[:] = lats
v_lon[:] = lons
v_afa[:] = afa
v_time[:] = [1747318470.0]  # 2025-05-15T12:34:30Z

ds.close()
print('wrote', OUT)
