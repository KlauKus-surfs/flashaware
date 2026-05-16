import { useEffect, useState } from 'react';
import api from '../api';
import { useRealtimeEvent } from '../RealtimeProvider';

export interface AfaPixel {
  observed_at_utc: string;
  pixel_lat: number;
  pixel_lon: number;
  flash_count: number;
  geometry: GeoJSON.Polygon;
}

// Wire shape emitted by the server's ingestAfaPixels via emitAfaUpdate.
// The server carries WKT strings; the client materialises them into GeoJSON.
interface AfaPixelWire {
  observed_at_utc: string;
  pixel_lat: number;
  pixel_lon: number;
  flash_count: number;
  geom_wkt: string;
}

/**
 * Parse a WKT polygon of the form POLYGON((x y, x y, ...)) into a GeoJSON
 * Polygon. Returns null if the string doesn't match that shape.
 */
function wktToPolygon(wkt: string): GeoJSON.Polygon | null {
  // Expects: POLYGON((x y, x y, x y, x y, x y))
  const m = wkt.match(/^POLYGON\(\((.+)\)\)$/);
  if (!m) return null;
  const coords = m[1].split(',').map((pair) => {
    const [x, y] = pair.trim().split(/\s+/).map(Number);
    return [x, y] as [number, number];
  });
  if (coords.length < 4) return null;
  return { type: 'Polygon', coordinates: [coords] };
}

let _wktWarnFired = false;

const WINDOW_MIN = 15;

export function useAfaPixels(): AfaPixel[] {
  const [pixels, setPixels] = useState<AfaPixel[]>([]);

  // Initial load + 30-second polling fallback.
  //
  // The poll response is MERGED into state rather than replacing it, because a
  // WS pixel can arrive AFTER the GET request was sent but BEFORE its response
  // lands. Naive setPixels(response) would clobber that newer WS pixel with the
  // older snapshot. The merge takes the union and prefers the entry with the
  // newer observed_at_utc per (pixel_lat, pixel_lon) key. The 15-minute window
  // is enforced after the merge, so aged-out pixels are evicted correctly.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
        const { data } = await api.get<{ features: any[] }>(`/afa-pixels?since=${since}`);
        if (cancelled) return;
        const fresh: AfaPixel[] = data.features.map((f) => ({
          ...f.properties,
          geometry: f.geometry,
        }));
        setPixels((prev) => {
          const cutoff = Date.now() - WINDOW_MIN * 60_000;
          const keyed = new Map(prev.map((p) => [`${p.pixel_lat},${p.pixel_lon}`, p]));
          for (const p of fresh) {
            const key = `${p.pixel_lat},${p.pixel_lon}`;
            const existing = keyed.get(key);
            if (
              !existing ||
              new Date(p.observed_at_utc).getTime() >=
                new Date(existing.observed_at_utc).getTime()
            ) {
              keyed.set(key, p);
            }
          }
          return [...keyed.values()].filter(
            (p) => new Date(p.observed_at_utc).getTime() >= cutoff,
          );
        });
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
  // The server emits ParsedAfaPixel objects with geom_wkt (WKT string); we
  // convert each to a GeoJSON Polygon before merging into local state so all
  // downstream consumers receive the expected AfaPixel shape.
  useRealtimeEvent<{ pixels: AfaPixelWire[] }>(
    'afa.update',
    (msg) => {
      setPixels((prev) => {
        const cutoff = Date.now() - WINDOW_MIN * 60_000;
        const keyed = new Map(prev.map((p) => [`${p.pixel_lat},${p.pixel_lon}`, p]));
        for (const wire of msg.pixels) {
          const geometry = wktToPolygon(wire.geom_wkt);
          if (!geometry) {
            if (!_wktWarnFired) {
              console.warn('useAfaPixels: failed to parse geom_wkt', wire.geom_wkt);
              _wktWarnFired = true;
            }
            continue;
          }
          const pixel: AfaPixel = {
            observed_at_utc: wire.observed_at_utc,
            pixel_lat: wire.pixel_lat,
            pixel_lon: wire.pixel_lon,
            flash_count: wire.flash_count,
            geometry,
          };
          keyed.set(`${pixel.pixel_lat},${pixel.pixel_lon}`, pixel);
        }
        return [...keyed.values()].filter(
          (p) => new Date(p.observed_at_utc).getTime() >= cutoff,
        );
      });
    },
  );

  return pixels;
}
