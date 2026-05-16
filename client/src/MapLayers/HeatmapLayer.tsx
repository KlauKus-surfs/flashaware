import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.heat';
import type { AfaPixel } from './useAfaPixels';

interface Props { pixels: AfaPixel[]; }

export function HeatmapLayer({ pixels }: Props) {
  const map = useMap();

  useEffect(() => {
    const points: Array<[number, number, number]> = pixels.map((p) => [
      p.pixel_lat, p.pixel_lon, p.flash_count,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = (L as any).heatLayer(points, { radius: 30, blur: 25, max: 10 });
    layer.addTo(map);
    return () => {
      map.removeLayer(layer);
    };
  }, [map, pixels]);

  return null;
}
