import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import type { LocationStatus } from './types';

// React-leaflet helper component: imperatively re-fits the map to all
// monitored locations whenever `version` bumps (used by the "Fit all" button
// and by location changes coming through the realtime channel).
export function FitAllBounds({
  locations,
  version,
}: {
  locations: LocationStatus[];
  version: number;
}) {
  const map = useMap();
  useEffect(() => {
    if (locations.length === 0) return;
    const bounds = locations.map((l) => [l.lat, l.lng] as [number, number]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9 });
  }, [locations, map, version]);
  return null;
}
