# ZENENERGIES Station

A full-stack, role-secured fuel-station operations platform for **Petrol** and **Diesel**. The client is React/Vite/TypeScript/Tailwind; the API is Node.js/Express with SQLite persistence. All money is denominated in **Kenyan Shillings (KSh)**.

The operational database starts empty. There are no seeded fuel prices, stock records, sales, expenses, shifts, or demonstration users. Schema migrations run transactionally on startup; the current canonical station contract is schema version 2 and retains stronger internal cent-based/FIFO accounting alongside the requested public fields.

## Features

- Role-picker JWT login for Admin and Attendant accounts
- Server-enforced admin boundaries and attendant response sanitization
- Shift opening/closing, live expected balances, and discrepancy summaries
- Quick cash/M-Pesa sale tally plus detailed fuel/pump entries
- Petrol/Diesel prices, tank stock, FIFO restocks, and audited adjustments
- Backdated pump and sales-meter readings with admin-only financial reconciliation
- Expenses, calendar activity, reports, CSV export, and month-over-month summary
- Users, settings, audit filtering/retention, JSON backup/restore, and destructive data reset
- Responsive desktop/mobile web application

## Repository layout

```text
client/                 React + Vite + TypeScript UI
server/app.js           Express composition and security middleware
server/db/              SQLite connection, migrations, integrity checks
server/routes/          REST endpoint modules
server/services/        Audit, settings, inventory, backup, bootstrap services
server/tests/           Temporary-database integration tests
server.js               Production API entrypoint (`node server.js`)
Dockerfile              Production backend image
render.yaml             Render API + static-site Blueprint
railway.json            Railway API configuration
vercel.json             Vercel SPA deployment
```

## Local setup

Prerequisites: Node.js 20+ and npm 10+.

```bash
# API
npm install
copy .env.example .env
npm run admin:bootstrap
npm run dev

# Frontend, in a second terminal
npm install --prefix client
copy client\.env.example client\.env
npm run dev:web
```

The Vite development server proxies `/api` to `http://localhost:3000`. Set `VITE_API_URL` for a separately hosted API. Never put a secret in a `VITE_*` variable; those values are compiled into browser assets.

There are no default login credentials. Supply a strong `ADMIN_USERNAME`/`ADMIN_PASSWORD` for explicit first-admin bootstrap, or create administrators through the Users screen after the first one exists. Remove bootstrap password variables from cloud environments after initialization.

## Environment

The API reads `PORT`, `NODE_ENV`, `JWT_SECRET`, `FRONTEND_ORIGINS` (or `CORS_ORIGINS`), `DATABASE_URL`/`DB_PATH`, and `TRUST_PROXY`. Production startup rejects missing/weak JWT secrets and wildcard CORS.

SQLite selection order is `DATABASE_URL`, then `DB_PATH`, then root `data/zenenergies.sqlite`. Absolute paths, relative paths, and local `file:` URLs are supported. The process creates the parent directory and enables foreign keys, WAL, a busy timeout, startup migrations, integrity checks, and graceful shutdown.

## Commands

```bash
npm start                 # node server.js
npm run dev               # API watch mode
npm run dev:web           # Vite development server
npm run build:web         # production frontend build
npm test                  # backend integration tests
npm run test:web          # frontend tests when configured
npm run check             # backend tests + frontend production build
npm run admin:bootstrap   # explicit first-admin command
npm run restore:backup -- ./backup.json  # offline validated recovery
```

Backend tests create a temporary SQLite database and remove it afterward. They do not populate the real operational database.

## Security model

The chosen login role must match the stored role. Passwords use bcrypt and are never serialized. JWTs include a server-side session version, so password changes, resets, role changes, and termination revoke old tokens. Helmet, strict CORS, rate limits, request limits, Zod validation, parameterized SQL, and centralized error envelopes are enabled.

Admins alone can access users, reports, monthly financials, audit data, fuel costs, global inventory, restocks, backups, platform metrics, and destructive controls. Meter reconciliation fields are never sent to attendants. Attendant lists are scoped to their own submissions. Frontend route guards are a usability layer; all authorization is repeated in backend middleware and serializers.

## API overview

All errors use a stable `{ success: false, error: { code, message, requestId } }` envelope. List endpoints are paginated and generally cap page size at 100. Amounts exposed by the API are decimal KSh values; integer cents/derived ledger values are used internally where appropriate.

| Area | Endpoints |
| --- | --- |
| Health/public settings | `GET /api/health`, `GET /api/settings/public` |
| Auth/users | `POST /api/auth/login`, `GET /api/auth/me`, password change; admin user CRUD/reset/terminate under `/api/users` |
| Dashboard/calendar | `GET /api/dashboard`, `GET /api/calendar` |
| Shifts/sales | authenticated shift open/close/history; authenticated sale create/list and admin delete |
| Expenses | authenticated owner/admin CRUD |
| Fuel | authenticated fuel types and pump lists; admin fuel/price/pump configuration, restock CRUD, and audited physical stock adjustment |
| Meters | authenticated owner/admin pump and sales reading list/create/update/delete/backdate; admin-only reconciliation fields |
| Reports | admin range report, monthly MoM report, and operational CSV export |
| Administration | admin settings, platform metrics, audit query/wipe, backup/restore, and clear operational data |

See `server/routes` for request validation and `DEPLOYMENT.md` for cloud setup.

## Inventory and financial model

Restocks create cost lots. Pump-meter consumption allocates stock FIFO, yielding a credible cost of fuel sold. A pump reading's admin reconciliation is `(closing − previous-day closing) × selling price`; a sales-meter reading's reconciliation is `closing − previous-day closing` in KSh. Sales-meter entries never deduct tank stock a second time. The default low-stock alert threshold is 400 litres and is configurable by admins.

## Backup safety

Admin backup downloads are complete, checksummed JSON snapshots. Restore validates format, schema, columns, types, relationships, users/password hashes, canonical totals, inventory lots, and allocations before replacing data in one SQLite transaction. The current administrator must exist with a matching session for web restore; the offline CLI can validate the snapshot's active administrator when emergency recovery is required. Backup files contain password hashes and must be treated as sensitive.

`Clear operational data` is isolated, rejects open shifts by default, preserves users/settings/audit evidence plus Petrol/Diesel definitions, prices, capacities, and pump configuration, resets tank stock to zero, and records the action. Use the in-app snapshot for application-level recovery and provider disk snapshots for infrastructure recovery.

## Deployment

Frontend hosting files are included for Vercel, Netlify, and Render. Backend Docker and cloud configurations target a single API replica with a persistent disk. SQLite must not be replicated across multiple writable instances.

See:

- `DEPLOYMENT.md` — Render, Railway, Vercel, and Netlify setup
- `SECURITY.md` — operational security and incident guidance
- `.env.example` — backend environment reference
- `client/.env.example` — frontend environment reference
