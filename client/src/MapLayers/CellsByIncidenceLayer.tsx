import { useMemo } from 'react';
import { GeoJSON } from 'react-leaflet';
import type { AfaPixel } from './useAfaPixels';

function incidenceColor(count: number): string {
  // Pale → saturated red ramp, count 1..>=10
  const t = Math.min(1, Math.max(0, (count - 1) / 9));
  const r = 255;
  const gb = Math.round(220 - t * 200);
  return `rgb(${r},${gb},${gb})`;
}

interface Props { pixels: AfaPixel[]; }

export function CellsByIncidenceLayer({ pixels }: Props) {
  const featureCollection = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: pixels.map((p) => ({
      type: 'Feature' as const,
      geometry: p.geometry,
      properties: { count: p.flash_count },
    })),
  }), [pixels]);

  return (
    <GeoJSON
      key={`incidence-${pixels.length}`}
      data={featureCollection}
      style={(f: any) => ({
        color: incidenceColor(f.properties.count),
        fillColor: incidenceColor(f.properties.count),
        fillOpacity: 0.7,
        weight: 0,
      })}
    />
  );
}
