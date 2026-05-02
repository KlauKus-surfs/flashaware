// Shapes consumed by the Dashboard view's child components. Kept here so the
// extracted children don't need to reach back into Dashboard.tsx for them.

export interface LocationStatus {
  id: string;
  name: string;
  site_type: string;
  lng: number;
  lat: number;
  state: string | null;
  reason: any;
  evaluated_at: string | null;
  flashes_in_stop_radius: number | null;
  flashes_in_prepare_radius: number | null;
  nearest_flash_km: number | null;
  data_age_sec: number | null;
  is_degraded: boolean | null;
  stop_radius_km?: number;
  prepare_radius_km?: number;
  is_demo?: boolean;
  active_recipient_count?: number;
}

export interface Flash {
  flash_id: number;
  flash_time_utc: string;
  latitude: number;
  longitude: number;
  radiance: number | null;
  duration_ms: number | null;
  filter_confidence: number | null;
}
