import { useEffect } from 'react';
import { CircleMarker, Popup, useMapEvents, useMap } from 'react-leaflet';

// Pan-to-coords helper. Render inside <MapContainer> with the current lat/lng
// and the map will fly to it whenever they change. Used by the location
// editor so search/click selections smoothly recenter the picker.
export function MapFlyTo({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo([lat, lng], map.getZoom(), { duration: 0.8 });
  }, [lat, lng, map]);
  return null;
}

// Click-to-set-centroid marker. Renders the current centroid as a yellow dot
// and updates onChange when the operator clicks elsewhere on the map.
export function CentroidPicker({
  lat,
  lng,
  onChange,
}: {
  lat: number;
  lng: number;
  onChange: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      onChange(e.latlng.lat, e.latlng.lng);
    },
  });
  return (
    <CircleMarker
      center={[lat, lng]}
      radius={8}
      pathOptions={{ color: '#fbc02d', fillColor: '#fbc02d', fillOpacity: 0.9 }}
    >
      <Popup>
        Site centroid: {lat.toFixed(4)}, {lng.toFixed(4)}
      </Popup>
    </CircleMarker>
  );
}
