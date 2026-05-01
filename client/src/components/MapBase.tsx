import React, { useState } from 'react';
import { Box } from '@mui/material';
import { MapContainer, TileLayer } from 'react-leaflet';
import type { LatLngExpression, LatLngBoundsExpression, MapOptions } from 'leaflet';
import MapTilePlaceholder from './MapTilePlaceholder';

// Shared MapContainer + TileLayer wrapper for every map in the app.
//
// Each screen used to repeat the same scaffolding (placeholder while tiles
// load, MapContainer with a fixed style, TileLayer with the right basemap,
// onLoad → setTilesLoaded) and one screen used a different basemap from
// another. MapBase owns that scaffolding so screens can focus on the
// markers / overlays / flash trail they actually want to render.
//
// `basemap`:
//   - 'dark'     → CARTO dark_all. Dashboard storm view; high contrast for
//                  brightly-coloured flash markers.
//   - 'voyager'  → CARTO voyager. Replay + LocationFormDialog editor view;
//                  better-contrast labels for "which block did this land
//                  on?" decisions.

const TILE_URLS = {
  dark:    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  voyager: 'https://{s}.basemaps.cartocdn.com/voyager/{z}/{x}/{y}{r}.png',
} as const;

export type Basemap = keyof typeof TILE_URLS;

interface Props {
  basemap?: Basemap;
  center: LatLngExpression;
  zoom?: number;
  bounds?: LatLngBoundsExpression;
  scrollWheelZoom?: MapOptions['scrollWheelZoom'];
  // Style applied to the MapContainer. Defaults to filling the wrapping Box.
  style?: React.CSSProperties;
  // The wrapping <Box> defaults to position: relative so the placeholder can
  // overlay it. Pass any sx overrides to control height / radius / etc.
  sx?: React.ComponentProps<typeof Box>['sx'];
  children?: React.ReactNode;
}

export function MapBase({
  basemap = 'dark',
  center, zoom = 6, bounds, scrollWheelZoom = true,
  style = { height: '100%', width: '100%' },
  sx,
  children,
}: Props) {
  const [tilesLoaded, setTilesLoaded] = useState(false);

  return (
    <Box sx={{ position: 'relative', height: '100%', width: '100%', ...sx }}>
      <MapTilePlaceholder visible={!tilesLoaded} />
      <MapContainer
        center={center}
        zoom={zoom}
        bounds={bounds}
        style={style}
        scrollWheelZoom={scrollWheelZoom}
      >
        <TileLayer
          attribution='&copy; <a href="https://carto.com/">CARTO</a>'
          url={TILE_URLS[basemap]}
          eventHandlers={{ load: () => setTilesLoaded(true) }}
        />
        {children}
      </MapContainer>
    </Box>
  );
}
