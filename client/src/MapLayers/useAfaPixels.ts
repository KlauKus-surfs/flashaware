import { useEffect, useState } from 'react';
import api from '../api';
// The app has a single shared WebSocket via RealtimeProvider. We subscribe
// to 'afa.update' via useRealtimeEvent, casting the event name because
// EventName is a closed union that does not yet include 'afa.update'.
import { useRealtimeEvent } from '../RealtimeProvider';

export interface AfaPixel {
  observed_at_utc: string;
  pixel_lat: number;
  pixel_lon: number;
  flash_count: number;
  geometry: GeoJSON.Polygon;
}

const WINDOW_MIN = 15;

export function useAfaPixels(): AfaPixel[] {
  const [pixels, setPixels] = useState<AfaPixel[]>([]);

  // Initial load + 30-second polling fallback.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
        const { data } = await api.get<{ features: any[] }>(`/afa-pixels?since=${since}`);
        if (cancelled) return;
        setPixels(
          data.features.map((f) => ({
            ...f.properties,
            geometry: f.geometry,
          })),
        );
      } catch (err) {
        // Polling failure is non-fatal; keep last state and retry next interval.
        console.warn('useAfaPixels: load failed', err);
      }
    }
    load();
    const fallback = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(fallback);
    };
  }, []);

  // Socket handler via the shared RealtimeProvider context. Merges incoming
  // pixels into local state, evicting entries older than WINDOW_MIN minutes.
  // Cast required: 'afa.update' is not yet in the closed EventName union.
  useRealtimeEvent<{ pixels: AfaPixel[] }>(
    'afa.update' as any,
    (msg) => {
      setPixels((prev) => {
        const cutoff = Date.now() - WINDOW_MIN * 60_000;
        const keyed = new Map(prev.map((p) => [`${p.pixel_lat},${p.pixel_lon}`, p]));
        for (const np of msg.pixels) keyed.set(`${np.pixel_lat},${np.pixel_lon}`, np);
        return [...keyed.values()].filter(
          (p) => new Date(p.observed_at_utc).getTime() >= cutoff,
        );
      });
    },
  );

  return pixels;
}
