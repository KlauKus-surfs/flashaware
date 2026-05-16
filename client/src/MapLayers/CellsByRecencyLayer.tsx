import { useMemo } from 'react';
import { GeoJSON } from 'react-leaflet';
import type { AfaPixel } from './useAfaPixels';

function recencyColor(ageMs: number): string {
  if (ageMs < 30_000) return '#fff200';
  if (ageMs < 120_000) return '#ff9800';
  return '#b71c1c';
}

interface Props { pixels: AfaPixel[]; }

export function CellsByRecencyLayer({ pixels }: Props) {
  const now = Date.now();

  const featureCollection = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: pixels
      .filter((p) => now - new Date(p.observed_at_utc).getTime() < 5 * 60_000)
      .map((p) => ({
        type: 'Feature' as const,
        geometry: p.geometry,
        properties: { ageMs: now - new Date(p.observed_at_utc).getTime() },
      })),
  }), [pixels, now]);

  return (
    <GeoJSON
      key={`recency-${pixels.length}-${now}`}
      data={featureCollection}
      style={(f: any) => ({
        color: recencyColor(f.properties.ageMs),
        fillColor: recencyColor(f.properties.ageMs),
        fillOpacity: 0.6,
        weight: 0,
      })}
    />
  );
}
