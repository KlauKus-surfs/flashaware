import { useEffect, useState } from 'react';
import { GeoJSON } from 'react-leaflet';
import api from '../api';

interface ThreatFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
    properties: { location_id: string; location_name: string };
  }>;
}

export function ThreatPolygonLayer() {
  const [data, setData] = useState<ThreatFeatureCollection | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.get<ThreatFeatureCollection>('/api/afa-threat-polygons');
        if (!cancelled) setData(res.data);
      } catch (err) {
        console.warn('ThreatPolygonLayer: load failed', err);
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!data || !data.features.length) return null;

  // Drop features whose geometry is null (no AFA pixels intersect the radius).
  const featureCollection: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: data.features
      .filter((f) => f.geometry !== null)
      .map((f) => ({
        type: 'Feature' as const,
        geometry: f.geometry as GeoJSON.Geometry,
        properties: f.properties,
      })),
  };

  if (featureCollection.features.length === 0) return null;

  return (
    <GeoJSON
      key={`threat-${data.features.length}-${Date.now()}`}
      data={featureCollection}
      style={{ color: '#d50000', weight: 3, fillOpacity: 0 }}
    />
  );
}
