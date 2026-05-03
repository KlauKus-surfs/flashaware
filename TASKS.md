# FlashAware — Pending Tasks

## WhatsApp Template Approval

- [ ] **Wait for Meta template approval** (24-48h) — check `flashaware@gmail.com`
- [ ] **Once approved:** get the Content SID (starts with `HX`) from Twilio Console → Messaging → Content Template Builder → `flashaware_risk_alert`
- [ ] **Set the secret on Fly.io:**
  ```powershell
  fly secrets set TWILIO_WHATSAPP_TEMPLATE_SID="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" --app lightning-risk-api
  ```
- [ ] **Create additional templates** in Twilio Content Template Builder:
  - `flashaware_allclear` — dedicated all-clear (green) message
  - `flashaware_prepare` — prepare/warning state message
- [ ] Submit additional templates for Meta approval

## WhatsApp Message Tier Scaling

- [ ] Meta starts new accounts at **5 messages/24h** — this scales automatically as quality rating builds
- [ ] Monitor quality rating in Twilio Console → Messaging → Senders → WhatsApp Senders
- [ ] Tier 2 (1,000/day) unlocks after ~7 days of active use with good quality

## Business Registration

- [ ] Register **FlashAware** as a formal business entity
- [ ] Once registered, update the Meta Business Manager account from Vibe Surf School to FlashAware
- [ ] Update WhatsApp Business display name if needed

## Future Features (Backlog)

- [ ] **Billing / subscription management** per organisation
- [ ] **Native mobile apps** (iOS/Android) for push notifications — revisit when customer base justifies it
- [ ] **WhatsApp opt-in flow** — landing page where recipients can self-register their WhatsApp number for a location

## Security Hardening (Backlog)

- [ ] **Move JWT out of `localStorage` into an HTTP-only cookie + CSRF token.**
      Today the JWT lives in `localStorage` (`client/src/api.ts`), so any
      stored XSS in the SPA can read it. The current SPA has no
      `dangerouslySetInnerHTML` and the email templates are now escaped, so
      the immediate risk is small — but standard guidance is HTTP-only
      cookies. Tracked as a separate cleanup; touches every API call site.
- [ ] **Fan auth-cache invalidation across machines via Redis.**
      `invalidateAuthCache` is per-process; multi-machine deploys see at
      most `AUTH_RECHECK_TTL_MS` (5s) revocation lag. Adequate today; if we
      ever go to 5+ machines or extend the JWT TTL, publish invalidations
      over the same Redis adapter the websocket uses.

---

## Completed

- [x] Parallelise per-recipient dispatch in `alertService.dispatchAlerts`
      (bounded concurrency via `mapWithConcurrency`, channels-per-recipient
      run via `Promise.all`, throttle via `DISPATCH_CONCURRENCY` env)
- [x] Multi-tenancy with organisations and invite tokens
- [x] Admin UI for org and invite management
- [x] Self-registration page via invite link
- [x] `notify_sms` and `notify_whatsapp` columns on `location_recipients`
- [x] SMS alerts via Twilio (`+27600814704`)
- [x] WhatsApp alerts via Twilio (`+15558544718` / FlashAware)
- [x] Recipient UI with Phone, SMS toggle, WhatsApp toggle columns
- [x] SA geo permissions enabled on Twilio account
- [x] `flashaware_risk_alert` template submitted for Meta approval
- [x] Alert service updated to use approved template when `TWILIO_WHATSAPP_TEMPLATE_SID` is set
