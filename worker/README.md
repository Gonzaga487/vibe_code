# ZENENERGIES Cloudflare Worker API

This directory contains the optional Cloudflare Worker + D1 backend. The existing Node/Express/SQLite backend in `server/` remains the canonical local/in-process implementation and is not modified by this deployment path.

The Worker deliberately speaks the same `/api` REST contract as the Node service. It uses Hono, Zod, `jose` (HS256 JWTs), `bcryptjs`, and Cloudflare D1. Petrol and Diesel are the only accepted fuel types. All externally serialized money is decimal Kenyan shillings (`KSh`); cent-based values are used inside the ledger.

## Prerequisites

- Node.js 22+ and npm 10+
- A Cloudflare account and the Wrangler login state used for your account
- A D1 database

## Create the D1 database

From the repository root:

```bash
npm install --prefix worker
npm run worker:d1:create
# Equivalent Wrangler command (run from the repository root):
npx wrangler d1 create zenenergies-db --config wrangler.jsonc
```

Copy the returned database ID into `wrangler.jsonc`, replacing the literal `REPLACE_WITH_D1_DATABASE_ID`. The placeholder is deliberately not a usable database ID. Do not commit a real ID if your deployment policy treats it as sensitive.

## Local D1 migration and development

Create `worker/.dev.vars` from `worker/.dev.vars.example` and set a locally generated strong `JWT_SECRET`. The file is ignored by Git. Do not use a production secret in a local file.

```bash
npm run worker:migrate:local
npm run worker:dev
```

The local API is available at the Wrangler URL (normally `http://localhost:8787`). The default local CORS origin is `http://localhost:5173`. Override `FRONTEND_ORIGINS` in the Wrangler environment for other local clients; wildcard origins are rejected.

The first successful login can bootstrap one administrator from `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and optional `ADMIN_FULL_NAME` secret bindings. No migration seeds users or operational data. The bootstrap is ignored once any user exists, and the account is marked `mustChangePassword`. Remove those bindings after initialization.

## Secrets and production configuration

Set secrets through Wrangler; do not put them in `wrangler.jsonc`, `.dev.vars`, source files, or a frontend build:

```bash
npm --prefix worker run secret:jwt
npm --prefix worker run secret:admin-username
npm --prefix worker run secret:admin-password
npm --prefix worker run secret:admin-name
```

Set an exact production CORS allowlist in the Worker environment. The production value should be one or more comma-separated HTTPS origins, for example the deployed frontend origin. Never use `*`.

## Migrate and deploy

Review the D1 ID and migration file, then apply the migration remotely and deploy:

```bash
npm run worker:migrate:remote
npm run worker:deploy
```

The deploy script performs Wrangler's dry-run build first and then `wrangler deploy`. The application entry point is `worker/src/index.ts`; migrations are in `worker/migrations/*.sql`. The migration creates the final canonical schema-v2 tables plus Worker-only rate-limit, operation, and idempotency support tables. It creates no operational seed rows.

After deployment, verify `GET /api/health`, create the first administrator, change its password, then configure Petrol/Diesel, prices, pumps, and stock through the API/UI. Do not run the Node SQLite bootstrap against a D1 database.

## API and security behavior

All routes are below `/api`. Errors use the stable envelope:

```json
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "...",
    "requestId": "..."
  }
}
```

The implementation includes:

- one JWT authentication middleware and hard administrator middleware;
- HS256 issuer/audience/expiry/session-version validation, bcrypt password hashes (cost 10 in the Worker), role matching at login, and forced-password-change paths;
- exact CORS allowlisting, security headers, request IDs, generic 5xx responses, and standard/restore body limits;
- a D1-backed login failure limiter. It is a best-effort distributed limiter suitable for a small station, not a replacement for an edge/WAF rate-limit rule;
- a daily scheduled cleanup for expired Worker operation, idempotency, and rate-limit records;
- strict Petrol/Diesel validation, amount-only Quick Tally sales, open-shift enforcement, owner-scoped attendant responses, and role-safe serializers;
- D1 `batch()` write groups for multi-record changes. Inventory operations use durable `api_operations` guards so a stale pre-read cannot partially apply a stock mutation;
- FIFO cost lots, pump-meter stock consumption and allocations, reverse movements on meter correction/deletion, weighted average cost, formal-vs-recorded revenue reports, monthly MoM, calendar events, expenses, audit, backup/restore, and clear operational data.

`/api/expenses` and meter readings are owner-scoped for attendants; financial reconciliation fields and global station financial data are not serialized to attendants. Admin-only routes enforce the boundary again on the Worker side.

## Backup and restore limits

Backup is a checksummed JSON snapshot in the same format and table allowlist as the Node service. Restore validates schema metadata, relationships, password records, money, inventory lots, and FIFO allocations before one D1 `batch()` transaction. The current administrator must be present with the same session version.

Cloudflare D1 requests, result sizes, SQL statement size, and Worker request limits are smaller than a local SQLite file. The Worker intentionally caps a backup/restore snapshot at 8 MiB and 20,000 rows. Restore is atomic for snapshots within that cap; larger datasets require an offline/provider-specific export and restore procedure. Backup files include password hashes and must be protected as sensitive credentials.

`clear operational data` preserves users, app settings, audit evidence, Petrol/Diesel definitions, prices, capacities, and pumps, while removing operational records and setting stock to zero. Open shifts require explicit force confirmation.

## Tests and build

```bash
npm --prefix worker run typecheck
npm --prefix worker test
npm --prefix worker run test:integration
npm --prefix worker run build
```

The unit suite covers pure money/date/query and inventory-planning helpers. The integration suite uses the Cloudflare Vitest pool and a local Miniflare D1 binding where the installed Wrangler version supports it. A manual local integration flow is also:

```bash
npm run worker:migrate:local
npm run worker:dev
```

Then exercise `/api/health`, `/api/settings/public`, login/bootstrap, fuel/pump setup, a shift, Quick Tally, meter readings, reports, backup, and clear-data confirmation against the local D1 instance.

## Known operational limitations

- D1 has no local SQLite file, synchronous `better-sqlite3` API, or cross-row interactive transaction. The Worker uses D1 statements and atomic `batch()` only; it never pretends a local file exists.
- D1 plan/request limits constrain backup size and the number of rows/lot allocations a single restore or FIFO allocation can handle. The explicit caps are fail-safe rather than silent truncation.
- Cloudflare Worker isolates are ephemeral. Secrets and operational records live in D1, not isolate memory. A single D1 database is the consistency boundary.
- `bcryptjs` is deliberately pure JavaScript to avoid native Worker modules. Password hashing is CPU-intensive; if the Cloudflare plan's CPU ceiling rejects authentication requests, use a plan with sufficient Worker CPU or an edge/WAF identity layer rather than weakening the password policy.
- A D1-backed limiter is not a globally serialized in-memory rate limiter. For internet-facing deployments, add Cloudflare WAF/Rate Limiting rules as a second layer.
- `FRONTEND_ORIGINS` is intentionally an exact allowlist. A browser origin not listed receives a CORS error; non-browser requests without an Origin remain usable for health checks and controlled clients.
