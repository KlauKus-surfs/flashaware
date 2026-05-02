// Shared form schema for the location editor. Both the parent
// (LocationEditor.tsx) and the LocationFormDialog import from here so the
// validation rules and the form contract live in one place.

export interface FormState {
  name: string;
  site_type: string;
  lat: number;
  lng: number;
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_flash_threshold: number;
  stop_window_min: number;
  prepare_flash_threshold: number;
  prepare_window_min: number;
  allclear_wait_min: number;
  persistence_alert_min: number;
  alert_on_change_only: boolean;
  is_demo: boolean;
}

export const defaultForm: FormState = {
  name: '',
  site_type: 'mine',
  lat: -26.2041,
  lng: 28.0473,
  stop_radius_km: 10,
  prepare_radius_km: 20,
  stop_flash_threshold: 1,
  stop_window_min: 15,
  prepare_flash_threshold: 1,
  prepare_window_min: 15,
  allclear_wait_min: 30,
  persistence_alert_min: 10,
  alert_on_change_only: false,
  is_demo: false,
};

export const SITE_TYPES = [
  { value: 'mine', label: 'Mine' },
  { value: 'golf_course', label: 'Golf Course' },
  { value: 'construction', label: 'Construction Site' },
  { value: 'event', label: 'Event Venue' },
  { value: 'wind_farm', label: 'Wind Farm' },
  { value: 'other', label: 'Other' },
];

// EUMETSAT MTG Lightning Imager spatial resolution. Sources:
//   • https://www.eumetsat.int/mtg-lightning-imager — EUMETSAT mission page
//   • https://www.esa.int/Applications/Observing_the_Earth/Meteorological_missions/meteosat_third_generation/Lightning_Imager
//     — ESA mission page ("spatial resolution around 10 km")
//   • https://www.eoportal.org/satellite-missions/meteosat-third-generation
//     — eoPortal MTG article ("< 10 km @ latitude 45° and subsatellite
//        longitude" — the official MTG spec requirement)
//
// Headline figures: ~4.5 km at the sub-satellite point, ≤10 km at 45°
// latitude. Southern Africa is viewed off-nadir from MTG at 0°/0°, so
// per-flash footprints over our coverage area are typically 5–8 km. A
// STOP radius smaller than the LI footprint is almost guaranteed to miss
// strikes silently — the engine sees the satellite-reported flash
// position rather than the (true, unknown) ground strike point, so a
// real hit on the site centroid commonly plots tens of pixels off-target
// inside a sub-pixel-radius zone.
//
// Threshold previously 3 km without a citation; raised to 5 km to align
// with the SSP pixel size. Power-user setups (ground-truth comparisons,
// tight-zone calibration sites) can still save through the warning.
export const STOP_RADIUS_WARNING_THRESHOLD_KM = 5;

export function hasValidCoordinates(form: Pick<FormState, 'lat' | 'lng'>): boolean {
  return (
    Number.isFinite(form.lat) &&
    form.lat >= -90 &&
    form.lat <= 90 &&
    Number.isFinite(form.lng) &&
    form.lng >= -180 &&
    form.lng <= 180 &&
    // Reject the (0, 0) "Null Island" default that comes from clearing both
    // inputs — an SA-focused operator never legitimately means the Gulf of
    // Guinea, so this is a much higher-signal save guard than just bounds.
    !(form.lat === 0 && form.lng === 0)
  );
}

export function validateForm(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = 'Required';
  if (!Number.isFinite(form.lat) || form.lat < -90 || form.lat > 90) {
    errors.lat = 'Latitude must be between -90 and 90';
  }
  if (!Number.isFinite(form.lng) || form.lng < -180 || form.lng > 180) {
    errors.lng = 'Longitude must be between -180 and 180';
  }
  if (!errors.lat && !errors.lng && form.lat === 0 && form.lng === 0) {
    // Catch the "form was cleared and saved as-is" case so super_admins can't
    // silently drop a placeholder pin off the coast of Africa.
    errors.lat = 'Pick a real location (search, type coordinates, or click the map)';
  }
  if (form.stop_radius_km <= 0) errors.stop_radius_km = 'Must be greater than 0';
  if (form.prepare_radius_km <= 0) errors.prepare_radius_km = 'Must be greater than 0';
  if (form.prepare_radius_km <= form.stop_radius_km)
    errors.prepare_radius_km = 'Must be larger than STOP radius';
  if (form.stop_flash_threshold < 1) errors.stop_flash_threshold = 'Must be at least 1';
  if (form.prepare_flash_threshold < 1) errors.prepare_flash_threshold = 'Must be at least 1';
  if (form.stop_window_min < 1) errors.stop_window_min = 'Must be at least 1';
  if (form.prepare_window_min < 1) errors.prepare_window_min = 'Must be at least 1';
  if (form.allclear_wait_min < 1) errors.allclear_wait_min = 'Must be at least 1';
  return errors;
}
