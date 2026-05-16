// Barrel re-export. Every consumer imports from './queries' as before — the
// per-domain modules under server/queries/ are an internal organisation
// concern only. Splitting one 1000-line file made cross-domain `org_id`
// scoping easier to spot in code review and let editors actually paint
// the relevant chunk on screen.
//
// Domain map:
//   users            → users.ts
//   locations        → locations.ts
//   risk states      → risk.ts
//   alerts           → alerts.ts
//   ingestion log    → ingestion.ts
//   recipients       → recipients.ts
//   phone OTP        → phoneOtp.ts
//   app/org settings → appSettings.ts, orgs.ts
//   db health        → health.ts
//   flash queries    → re-exported from ../db (authoritative there)

export * from './queries/users';
export * from './queries/locations';
export * from './queries/risk';
export * from './queries/alerts';
export * from './queries/ingestion';
export * from './queries/recipients';
export * from './queries/phoneOtp';
export * from './queries/appSettings';
export * from './queries/orgs';
export * from './queries/health';

// Flash event queries are owned by ./db; surface them through the same
// import path callers already use so existing call sites don't change.
export {
  countFlashesInRadius,
  getNearestFlashDistance,
  getTimeSinceLastFlashInRadius,
  getFlashTrend,
  getRecentFlashes,
  countLitPixelsAndIncidence,
  nearestLitPixelKm,
  getTimeSinceLastPixelInRadius,
  getAfaTrend,
} from './db';
