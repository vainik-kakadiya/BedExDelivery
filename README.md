# BedEx Delivery Portal

Orders, route planning and optimisation, a driver PWA, proof of delivery and public tracking for BedEx Delivery.
The PRD (v1.0, 12/11/2026) is the source of requirements. IDs like `ORD-03` below refer to it.

## Quick start

Requires Node 20.11+ and pnpm 9 (`corepack enable`, or `npx pnpm@9.15.0 …`).

```bash
pnpm install
cp .env.example .env          # fill DATABASE_URL (Supabase) + JWT_ACCESS_SECRET
pnpm db:migrate               # applies packages/db/migrations
pnpm db:seed                  # first admin from SEED_ADMIN_* + default settings
pnpm dev                      # API :4000, web :5173 (proxies /api)
```

| Script | What it does |
|---|---|
| `pnpm lint` / `typecheck` / `test` / `build` | Same steps CI runs |
| `pnpm db:generate` | New migration after editing `packages/db/src/schema.ts` |
| `pnpm db:seed:demo` | Demo depot, vans, drivers, routes and orders timed around "now". `--reset` removes them |
| `pnpm db:studio` | Drizzle Studio |

## Layout

```
apps/
  api/        Express 5 API (/api/v1), bundled with tsup for PM2
  web/        React app: /office (admin/office), /driver (PWA), /track (public)
packages/
  shared/     Status machine, enums, Zod schemas, UK formatting, shared types
  db/         Drizzle schema (all PRD §7 tables), migrations, seed
```

## Decisions taken where the PRD left a choice

- **Express 5** over Fastify. It has native async error handling and the larger middleware ecosystem.
- **Drizzle** over Prisma. Its SQL-first style suits trigram search and the keyset pagination.
- **HS256** access tokens (15 min) via `jose`. Refresh tokens are 7 days, stored as SHA-256 hashes, rotated on every use and grouped into families. Reusing a revoked token revokes the whole family. A 10-second grace window covers two tabs refreshing at the same moment.
- **argon2id** (`@node-rs/argon2`, prebuilt binaries). Accounts lock for 15 minutes after 5 failed sign-ins.
- **Tracking refs** are `BDX` + 9 characters from a 32-character alphabet with no 0/O/1/I. Legacy references keep their original format.
- **Reopen** (admin only) moves a Delivered or Cancelled order back to *Awaiting scheduling*.
- **Rescheduled** requires the new agreed date.
- **Route detachment:** moving an order to Awaiting scheduling, In warehouse, Rescheduled, Returned or Cancelled detaches it from its route. On a draft or released route the stop is deleted. On a started or completed route the stop is kept as a record of what happened.
- **RLS is enabled on every table with no policies.** That shuts off Supabase's auto-generated REST API (the anon and authenticated roles) completely. The API connects as the owning `postgres` role, so it isn't affected. Every new table must end in `.enableRLS()`.
- The refresh cookie is `SameSite=Strict`. **Host the API on the same site as the portal** (e.g. `portal.` and `api.bedexdelivery.co.uk`, or proxy `/api` through Nginx), otherwise the cookie won't be sent.

## Status against the PRD

**Done (week 1 foundation + core of weeks 2–3)**
- Monorepo, CI (lint, typecheck, test, build), env template.
- Full data model and migrations, including pg_trgm GIN indexes and the idempotency key on `delivery_attempts` for offline replays.
- §6 status machine in `packages/shared`, the single source used by both API and UI. The API's `transitionOrder()` is the one path for every status change, and each change writes an `order_events` row (HST-01).
- Auth: login, refresh, logout and me. RBAC middleware is on every router.
- Orders: list with search, filters and cursor pagination (ORD-03/04); create; get; patch with field-level diff history; status change returning 409 on invalid moves; history (events + attempts).
- `GET /driver/routes/today`, scoped server-side to the caller's `driver_id`, returning an explicit allow-list of order columns (no internal notes).
- `GET /public/track`: ref + postcode must both match, one generic error for every failure, 10 requests/min/IP, response built field by field.
- Web: design tokens, office shell, sign-in, orders list, driver shell (PWA manifest + service worker, offline banner), public tracking page.
- **Office dashboard (DSH-01 – DSH-07):**
  - Summary cards, today's routes (progress, ETA drift, last update), and an action queue with Reschedule / Return / Cancel.
  - Live map. It needs `VITE_GOOGLE_MAPS_BROWSER_KEY`; without the key it shows a list of drivers' last positions instead.
  - Orders page filters (date, driver, route, postcode, status) kept in the URL.
  - Exports in CSV, XLSX and PDF for the order list, delivery report and route manifest. Each export is written to the audit log.
  - Realtime updates: Postgres statement-level triggers `NOTIFY bedex_changes`, the API `LISTEN`s and pushes Server-Sent Events, and the browser refetches the affected data. The browser never connects to Supabase directly. If the stream drops, the dashboard polls every 10 s.
  - ETA drift is measured against the planned ETAs; it becomes live once Routes API recalculation (RTE-07) lands.

- **Route planner (RTE-01 – RTE-10)** at `/office/planner`. Depots (admin) and Settings pages included.
  - Pick a date. Eligible orders are listed: awaiting/in warehouse (undated or due), and rescheduled to that day or overdue.
  - Tick the drivers and vans working that day, then **Optimise**. This runs as an async job with progress and replaces that day's drafts.
  - Edits: drag stops to reorder or move them between routes; drag to *Unassigned* to remove. Arrow and × buttons do the same from the keyboard. Each edit recalculates ETAs, miles and durations. *Re-optimise* reorders a single route.
  - Warnings: over capacity (units/kg/m³), ETA outside window, over working hours, missing geocode, no driver/van.
  - Route states: Draft ⇄ Released. Editing a released route sets `changed_at`, logs `route_changed` / `route_resequenced` / `route_reassigned` in order history, and the driver app refreshes live with a "route changed" banner.
  - Orders on a route are *Scheduled*. Taking one off restores *Rescheduled* (keeping its date) or *Awaiting scheduling*.
  - Drivers and vans already on a released route that day are not double-booked.

### Routing engines

`apps/api/src/modules/planning/engine` picks the best provider for each job:

| Configured | Optimisation (RTE-04) | Travel times / ETAs (RTE-07) |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` + `GOOGLE_CLOUD_PROJECT_ID` | Route Optimization API `optimizeTours` | – |
| `GOOGLE_MAPS_SERVER_KEY` | – | Routes API `computeRoutes` (≤25 waypoints per call, stitched) |
| nothing | built-in: cheapest insertion + relocate/2-opt | straight line × 1.35 at 24 km/h + 2 min parking |

Estimated routes are labelled **Estimated** in the UI and drawn as dashed straight lines.
- The Google request/response mapping is unit-tested against the documented formats, but it has **not been run against Google yet**.
- The Route Optimization API rejects API keys and needs a service account.
- If a Routes API call fails, it falls back to estimates and logs a warning.

- **Drivers & vans (DRV-01 – DRV-05).** `/office/drivers` and `/office/vans`. Creating and editing drivers (including their logins) and vans is admin-only, per PRD §2; office staff can view both and reassign.
  - **Drivers:** login by email and/or mobile, working hours, max hours, default van, optional home location. Deactivating a driver revokes their sessions and blocks sign-in; their history is kept. A password reset also signs them out.
  - **Vans:** registration (unique, ignoring spaces) and capacity in units/kg/m³.
  - **Busy drivers and vans:** neither can be deactivated while on a released or in-progress route.
  - **Progress (DRV-04):** each driver's route for the day, stops done/total, current stop with ETA, and last GPS ping. Updates live.
  - **Reassignment (DRV-05):** whole route → another driver/van (`PATCH /routes/:id`), or individual outstanding stops → another route on the same day, including from a route already on the road (`POST /routes/:id/stops/transfer`). Completed stops can't move, and stops already out for delivery can't move onto a draft. Both drivers' apps refresh; each order's history records `route_changed` with the from/to drivers.
  - **In-progress ETAs:** recalculation only re-times outstanding stops, from the last completed stop, starting now.

**Not started.**
- Order create/edit UI, import with column mapping and duplicate detection (ORD-05/06), geocoding (ORD-07), Shopify (ORD-08)
- Office/admin user management (ACC-01)
- Driver start/complete route and stops, photo upload, IndexedDB offline queue, GPS (DRP-03…09). These move routes to *In progress* / *Completed* (the rest of RTE-09).
- Optimisation jobs live in memory: a single API process (PM2 fork mode) is fine; several processes would need BullMQ/Redis.
- Audit-log viewer and data migration (ACC-03 viewer, ACC-05)
- Postgres RLS as the second layer for driver data (ACC-02). Today the API layer enforces it.

## Blocked on the client (PRD §14)

- **Brand colours and logo.** The three `--brand-*` values in [apps/web/src/styles.css](apps/web/src/styles.css) and the SVG icon are placeholders.
- Depot postcode(s), van capacities and capacity rules, service-time defaults, time-window format.
- Access to the current site's database, needed for migration and for keeping legacy tracking refs working.
