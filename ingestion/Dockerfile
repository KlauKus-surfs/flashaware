FROM python:3.11-slim

WORKDIR /app

# System deps for netCDF4 / HDF5
RUN apt-get update && apt-get install -y --no-install-recommends \
    libhdf5-dev libnetcdf-dev gcc g++ \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

ENV PYTHONUNBUFFERED=1

CMD ["python", "collector.py"]
