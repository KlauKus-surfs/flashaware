import { DateTime } from 'luxon';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

// ============================================================
// In-memory data stores (replaces PostgreSQL)
// ============================================================

export interface FlashEvent {
  id: number;
  flash_id: number;
  flash_time_utc: string;
  latitude: number;
  longitude: number;
  radiance: number | null;
  duration_ms: number | null;
  duration_clamped_ms: number | null;
  footprint: number | null;
  num_groups: number;
  num_events: number;
  filter_confidence: number | null;
  is_truncated: boolean;
  product_id: string;
  ingested_at: string;
}

export interface Location {
  id: string;
  name: string;
  site_type: string;
  lat: number;
  lng: number;
  timezone: string;
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_flash_threshold: number;
  stop_window_min: number;
  prepare_flash_threshold: number;
  prepare_window_min: number;
  allclear_wait_min: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RiskStateRecord {
  id: number;
  location_id: string;
  state: string;
  previous_state: string | null;
  changed_at: string;
  reason: any;
  flashes_in_stop_radius: number;
  flashes_in_prepare_radius: number;
  nearest_flash_km: number | null;
  data_age_sec: number;
  is_degraded: boolean;
  evaluated_at: string;
}

export interface AlertRecord {
  id: number;
  location_id: string;
  state_id: number;
  alert_type: string;
  recipient: string;
  sent_at: string | null;
  delivered_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  escalated: boolean;
  error: string | null;
}

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'super_admin' | 'representative' | 'admin' | 'operator' | 'viewer';
}

export interface IngestionRecord {
  product_id: string;
  product_time_start: string;
  product_time_end: string;
  flash_count: number;
  ingested_at: string;
  qc_status: string;
}

// --- Stores ---
export const flashEvents: FlashEvent[] = [];
export const locations: Location[] = [];
export const riskStates: RiskStateRecord[] = [];
export const alerts: AlertRecord[] = [];
export const ingestionLog: IngestionRecord[] = [];
export const users: UserRecord[] = [];

let flashIdCounter = 1;
let riskStateIdCounter = 1;
let alertIdCounter = 1;

// ============================================================
// Seed data
// ============================================================

export function seedData(liveMode: boolean = false) {
  // Generate bcrypt hash at startup to guarantee correctness
  const hash = bcrypt.hashSync('admin123', 10);

  // Users (always needed)
  users.push(
    {
      id: crypto.randomUUID(),
      email: 'admin@lightning.local',
      password_hash: hash,
      name: 'Admin',
      role: 'admin',
    },
    {
      id: crypto.randomUUID(),
      email: 'operator@lightning.local',
      password_hash: hash,
      name: 'Operator',
      role: 'operator',
    },
    {
      id: crypto.randomUUID(),
      email: 'viewer@lightning.local',
      password_hash: hash,
      name: 'Viewer',
      role: 'viewer',
    },
  );

  // Locations (always needed)
  const demoLocations: Omit<Location, 'id' | 'created_at' | 'updated_at'>[] = [
    {
      name: 'Johannesburg CBD',
      site_type: 'construction',
      lat: -26.2041,
      lng: 28.0473,
      timezone: 'Africa/Johannesburg',
      stop_radius_km: 10,
      prepare_radius_km: 20,
      stop_flash_threshold: 3,
      stop_window_min: 5,
      prepare_flash_threshold: 1,
      prepare_window_min: 15,
      allclear_wait_min: 30,
      enabled: true,
    },
    {
      name: 'Rustenburg Platinum Mine',
      site_type: 'mine',
      lat: -25.6667,
      lng: 27.25,
      timezone: 'Africa/Johannesburg',
      stop_radius_km: 10,
      prepare_radius_km: 20,
      stop_flash_threshold: 3,
      stop_window_min: 5,
      prepare_flash_threshold: 1,
      prepare_window_min: 15,
      allclear_wait_min: 30,
      enabled: true,
    },
    {
      name: 'Durban Beachfront',
      site_type: 'event',
      lat: -29.8587,
      lng: 31.0218,
      timezone: 'Africa/Johannesburg',
      stop_radius_km: 10,
      prepare_radius_km: 20,
      stop_flash_threshold: 3,
      stop_window_min: 5,
      prepare_flash_threshold: 1,
      prepare_window_min: 15,
      allclear_wait_min: 30,
      enabled: true,
    },
    {
      name: 'Sun City Golf Course',
      site_type: 'golf_course',
      lat: -25.3346,
      lng: 27.0928,
      timezone: 'Africa/Johannesburg',
      stop_radius_km: 10,
      prepare_radius_km: 20,
      stop_flash_threshold: 3,
      stop_window_min: 5,
      prepare_flash_threshold: 1,
      prepare_window_min: 15,
      allclear_wait_min: 30,
      enabled: true,
    },
  ];

  const now = DateTime.utc().toISO()!;
  for (const loc of demoLocations) {
    locations.push({
      ...loc,
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
    });
  }

  if (!liveMode) {
    // Only seed fake flashes and ingestion log in mock mode
    seedFlashEvents();
    seedIngestionLog();
    console.log(
      `  Seeded: ${users.length} users, ${locations.length} locations, ${flashEvents.length} flashes`,
    );
  } else {
    console.log(
      `  Seeded: ${users.length} users, ${locations.length} locations (live mode — no mock flashes)`,
    );
  }
}

function seedFlashEvents() {
  const now = DateTime.utc();

  // Generate flashes for a realistic scenario:
  // - JHB: active storm (STOP) — many flashes close
  // - Rustenburg: approaching storm (PREPARE) — some flashes in 20km
  // - Durban: clear (ALL_CLEAR)
  // - Sun City: holding (HOLD) — had flashes 15 min ago

  const jhb = locations.find((l) => l.name.includes('Johannesburg'))!;
  const rust = locations.find((l) => l.name.includes('Rustenburg'))!;
  const sunCity = locations.find((l) => l.name.includes('Sun City'))!;

  // JHB — active storm: 5 flashes within 8km in last 3 min
  for (let i = 0; i < 5; i++) {
    addFlash(
      jhb.lat + (Math.random() - 0.5) * 0.08,
      jhb.lng + (Math.random() - 0.5) * 0.08,
      now.minus({ minutes: Math.random() * 3 }).toISO()!,
      `jhb-storm-${i}`,
    );
  }
  // JHB — more flashes trailing out to 15km
  for (let i = 0; i < 8; i++) {
    addFlash(
      jhb.lat + (Math.random() - 0.5) * 0.2,
      jhb.lng + (Math.random() - 0.5) * 0.2,
      now.minus({ minutes: 3 + Math.random() * 12 }).toISO()!,
      `jhb-trail-${i}`,
    );
  }

  // Rustenburg — approaching: 2 flashes at 12–18km range, last 10 min
  for (let i = 0; i < 2; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const dist = 0.12 + Math.random() * 0.06; // ~12-18km in degrees
    addFlash(
      rust.lat + Math.sin(angle) * dist,
      rust.lng + Math.cos(angle) * dist,
      now.minus({ minutes: 2 + Math.random() * 10 }).toISO()!,
      `rust-approach-${i}`,
    );
  }

  // Sun City — flashes from 20 min ago, now winding down
  for (let i = 0; i < 4; i++) {
    addFlash(
      sunCity.lat + (Math.random() - 0.5) * 0.12,
      sunCity.lng + (Math.random() - 0.5) * 0.12,
      now.minus({ minutes: 18 + Math.random() * 8 }).toISO()!,
      `sc-old-${i}`,
    );
  }

  // Scatter some random flashes across SA for map interest
  for (let i = 0; i < 20; i++) {
    const lat = -24 - Math.random() * 8; // -24 to -32
    const lng = 25 + Math.random() * 8; // 25 to 33
    addFlash(lat, lng, now.minus({ minutes: Math.random() * 30 }).toISO()!, `random-${i}`);
  }
}

function addFlash(lat: number, lng: number, timeUtc: string, tag: string) {
  const id = flashIdCounter++;
  const durMs = Math.floor(50 + Math.random() * 550);
  flashEvents.push({
    id,
    flash_id: 100000 + id,
    flash_time_utc: timeUtc,
    latitude: lat,
    longitude: lng,
    radiance: +(0.1 + Math.random() * 5).toFixed(3),
    duration_ms: durMs,
    duration_clamped_ms: Math.min(durMs, 600),
    footprint: +(10 + Math.random() * 200).toFixed(1),
    num_groups: 1 + Math.floor(Math.random() * 8),
    num_events: 2 + Math.floor(Math.random() * 30),
    filter_confidence: +(0.5 + Math.random() * 0.5).toFixed(3),
    is_truncated: false,
    product_id: `mock-product-${tag}`,
    ingested_at: DateTime.utc().toISO()!,
  });
}

function seedIngestionLog() {
  const now = DateTime.utc();
  // Create a few recent ingestion log entries so the feed looks healthy
  for (let i = 0; i < 5; i++) {
    const t = now.minus({ minutes: i * 10 });
    ingestionLog.push({
      product_id: `LI-2-LFL-mock-${i}`,
      product_time_start: t.minus({ minutes: 10 }).toISO()!,
      product_time_end: t.toISO()!,
      flash_count: 50 + Math.floor(Math.random() * 200),
      ingested_at: t.plus({ seconds: 20 }).toISO()!,
      qc_status: 'OK',
    });
  }
}

// ============================================================
// Geo helpers (Haversine distance in km)
// ============================================================

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// Query helpers (replace PostGIS queries)
// ============================================================

export function countFlashesInRadius(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
  windowMinutes: number,
  minConfidence: number = 0.5,
): number {
  const cutoff = DateTime.utc().minus({ minutes: windowMinutes }).toMillis();
  return flashEvents.filter((f) => {
    if (new Date(f.flash_time_utc).getTime() < cutoff) return false;
    if (f.filter_confidence !== null && f.filter_confidence < minConfidence) return false;
    return haversineKm(centerLat, centerLng, f.latitude, f.longitude) <= radiusKm;
  }).length;
}

export function getNearestFlashDistance(
  centerLat: number,
  centerLng: number,
  windowMinutes: number,
): number | null {
  const cutoff = DateTime.utc().minus({ minutes: windowMinutes }).toMillis();
  let nearest: number | null = null;
  for (const f of flashEvents) {
    if (new Date(f.flash_time_utc).getTime() < cutoff) continue;
    const d = haversineKm(centerLat, centerLng, f.latitude, f.longitude);
    if (nearest === null || d < nearest) nearest = d;
  }
  return nearest;
}

export function getTimeSinceLastFlashInRadius(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
): number | null {
  let latestTime: number | null = null;
  for (const f of flashEvents) {
    const d = haversineKm(centerLat, centerLng, f.latitude, f.longitude);
    if (d <= radiusKm) {
      const t = new Date(f.flash_time_utc).getTime();
      if (latestTime === null || t > latestTime) latestTime = t;
    }
  }
  if (latestTime === null) return null;
  return (Date.now() - latestTime) / 60000;
}

export function getLatestIngestionTime(): Date | null {
  if (ingestionLog.length === 0) return null;
  let latest = ingestionLog[0].product_time_end;
  for (const log of ingestionLog) {
    if (log.product_time_end > latest && log.qc_status !== 'ERROR') {
      latest = log.product_time_end;
    }
  }
  return new Date(latest);
}

export function getFlashTrend(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
): { recent: number; previous: number; trend: string } {
  const now = Date.now();
  const fiveMin = 5 * 60 * 1000;
  const fifteenMin = 15 * 60 * 1000;

  let recent = 0,
    previous = 0;
  for (const f of flashEvents) {
    const d = haversineKm(centerLat, centerLng, f.latitude, f.longitude);
    if (d > radiusKm) continue;
    const age = now - new Date(f.flash_time_utc).getTime();
    if (age <= fiveMin) recent++;
    else if (age <= fifteenMin) previous++;
  }

  let trend = 'stable';
  if (recent > previous * 1.5) trend = 'increasing';
  else if (previous > 0 && recent < previous * 0.5) trend = 'decreasing';

  return { recent, previous, trend };
}

export function getRecentFlashes(
  bbox?: { west: number; south: number; east: number; north: number },
  minutes: number = 30,
): FlashEvent[] {
  const cutoff = DateTime.utc().minus({ minutes }).toMillis();
  return flashEvents
    .filter((f) => {
      if (new Date(f.flash_time_utc).getTime() < cutoff) return false;
      if (bbox) {
        if (f.longitude < bbox.west || f.longitude > bbox.east) return false;
        if (f.latitude < bbox.south || f.latitude > bbox.north) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.flash_time_utc).getTime() - new Date(a.flash_time_utc).getTime())
    .slice(0, 10000);
}

// ============================================================
// State management
// ============================================================

export function addRiskState(record: Omit<RiskStateRecord, 'id'>): number {
  const id = riskStateIdCounter++;
  riskStates.push({ ...record, id });
  return id;
}

export function getLatestRiskState(locationId: string): RiskStateRecord | null {
  for (let i = riskStates.length - 1; i >= 0; i--) {
    if (riskStates[i].location_id === locationId) return riskStates[i];
  }
  return null;
}

export function addAlert(record: Omit<AlertRecord, 'id'>): number {
  const id = alertIdCounter++;
  alerts.push({ ...record, id });
  return id;
}

export function findUserByEmail(email: string): UserRecord | null {
  return users.find((u) => u.email === email) || null;
}

// ============================================================
// Continuous flash simulation (adds new flashes periodically)
// ============================================================

let simInterval: ReturnType<typeof setInterval> | null = null;

export function startFlashSimulation(intervalMs: number = 15000) {
  console.log(`  Flash simulator active (new flashes every ${intervalMs / 1000}s)`);
  simInterval = setInterval(() => {
    const now = DateTime.utc();
    // Generate flashes near each location with varying probability
    for (const loc of locations) {
      const chance = loc.name.includes('Johannesburg')
        ? 0.6
        : loc.name.includes('Sun City')
          ? 0.4
          : loc.name.includes('Rustenburg')
            ? 0.35
            : 0.2;
      if (Math.random() < chance) {
        // Random distance 1-15 km in a random direction
        const angle = Math.random() * 2 * Math.PI;
        const distDeg = (1 + Math.random() * 14) / 111; // km to degrees approx
        addFlash(
          loc.lat + Math.sin(angle) * distDeg,
          loc.lng + Math.cos(angle) * distDeg,
          now.toISO()!,
          `sim-${loc.name.substring(0, 3).toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        );
      }
    }
    // 15% chance of random flash somewhere in SA for map scatter
    if (Math.random() < 0.15) {
      addFlash(
        -24 - Math.random() * 8,
        25 + Math.random() * 8,
        now.toISO()!,
        `sim-rand-${Date.now()}`,
      );
    }
    // Prune very old flashes (>2 hours) to prevent memory growth
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    const beforeLen = flashEvents.length;
    while (
      flashEvents.length > 0 &&
      new Date(flashEvents[0].flash_time_utc).getTime() < twoHoursAgo
    ) {
      flashEvents.shift();
    }
  }, intervalMs);
}

export function stopFlashSimulation() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
}
