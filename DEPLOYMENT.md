# Deployment guide

The application is split into a static React client and a stateful Express/SQLite API. Deploy the API as a **single replica only**; do not put multiple Railway/Render instances on the same SQLite volume.

## Required API environment

| Variable | Requirement |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | Platform-provided or `3000` |
| `DATABASE_URL` | Absolute SQLite path on a persistent disk, e.g. `/app/data/zenenergies.sqlite` |
| `JWT_SECRET` | Unique secret, at least 40 bytes, with upper/lowercase letters, a number, and a symbol |
| `FRONTEND_ORIGINS` | Exact comma-separated HTTPS origins allowed to call the API |
| `TRUST_PROXY` | `1` when behind Render/Railway's trusted proxy |
| `ADMIN_USERNAME` | Required only for first-admin bootstrap |
| `ADMIN_PASSWORD` | Required only for first-admin bootstrap; remove after initialization |
| `ADMIN_FULL_NAME` | Optional first-admin display name |

`DB_PATH` can replace `DATABASE_URL`. Local `file:` SQLite URLs are accepted. If neither is set, the API creates `data/zenenergies.sqlite` beneath the project root.

## First administrator

There are intentionally no default users or seed accounts. Set explicit `ADMIN_USERNAME` and a strong `ADMIN_PASSWORD` for the first successful startup, or run:

```bash
npm run admin:bootstrap
```

After the administrator exists, remove bootstrap password variables from the hosting dashboard. Login requires username, password, and the matching Admin/Attendant role selection.

## Render

`render.yaml` defines:

- `zenenergies-api`: Docker web service with a 1 GB persistent disk mounted at `/app/data` and `/api/health` health checking.
- `zenenergies-web`: static Vite site built from `client` and published from `client/dist`.

Create the Blueprint, then provide strong values for every `sync: false` variable. Set the static site's `VITE_API_URL` to the API's public origin (for example `https://zenenergies-api.onrender.com/api`). Set the API's `FRONTEND_ORIGINS` to the static site's exact origin. After bootstrap, remove `ADMIN_PASSWORD` from the API environment and redeploy.

## Railway

`railway.json` builds the root Dockerfile and starts `node server.js`. In the Railway service:

1. Add a persistent volume mounted at `/app/data`.
2. Set `DATABASE_URL=/app/data/zenenergies.sqlite`.
3. Set `NODE_ENV=production`, `TRUST_PROXY=1`, a strong `JWT_SECRET`, and exact `FRONTEND_ORIGINS`.
4. Bootstrap the first admin once.
5. Keep exactly one replica; `requiredMountPath` intentionally prevents a deployment without the disk.

Deploy the `client` directory as a separate Railway static service, or deploy it to Vercel/Netlify. Set that service's `VITE_API_URL` to the API's `/api` origin.

## Vercel

Use the repository root as the project. `vercel.json` builds `client` and rewrites SPA routes to the client output. Set:

```text
VITE_API_URL=https://your-api-host.example/api
```

Use a production custom domain and set that exact origin in the API's `FRONTEND_ORIGINS`.

## Netlify

Use the root `netlify.toml`, which sets base directory `client`, runs `npm run build`, publishes `dist`, applies security headers, and supplies the SPA fallback. `client/public/_redirects` is also retained for hosts that copy the client build directly. Set the same `VITE_API_URL` environment variable.

## Optional Cloudflare Worker + D1 API

The repository also includes a stateless Cloudflare Worker backend in `worker/`. It preserves the existing `/api` response contracts and uses D1 instead of a persistent SQLite file. It does not modify or replace the Express backend.

1. Install Worker dependencies with `npm install --prefix worker`.
2. Run `npm run worker:d1:create` (Wrangler runs `wrangler d1 create zenenergies-db`) and replace the documented placeholder `database_id` in `wrangler.jsonc`.
3. Set `JWT_SECRET` with `npm --prefix worker run secret:jwt`. Set optional one-time `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_FULL_NAME` with the corresponding `npm --prefix worker run secret:admin-*` scripts; remove them after the first administrator is created.
4. Set an exact `FRONTEND_ORIGINS` allowlist in the Cloudflare Worker environment. Do not use wildcards.
5. Apply the canonical D1 migration with `npm run worker:migrate:remote`.
6. Deploy with `npm run worker:deploy`, then set the frontend `VITE_API_URL` to the Worker's public `/api` origin.

The Worker has no operational seed rows. D1 migration/schema rows are metadata only. It uses `db.batch()` for atomic multi-statement writes and never emulates a synchronous local SQLite API. Review `worker/README.md` before using it: backup/restore is intentionally capped for D1 request limits, login limiting is D1-backed rather than an edge WAF, and Cloudflare plan limits may affect large backups or FIFO lot histories. Do not run the Node SQLite migration/bootstrap commands against a D1 binding.

## Backups and retention

SQLite runs in WAL mode. Do not copy only the main `.sqlite` file while writes are active; use the authenticated **Backup & Restore** JSON snapshot, or stop the service before copying the database plus WAL files. Store backup files as sensitive because they include password hashes and complete operations. Test restores in a separate environment before relying on them.

The default low-stock threshold is 400 litres and can be changed by an administrator. Audit retention defaults to 365 days. The platform must also retain its own disk snapshots; application snapshots complement, rather than replace, infrastructure backups.

For emergency recovery when no valid web administrator session is available, stop the API and run the offline validator/restore command with the same `DATABASE_URL`:

```bash
npm run restore:backup -- ./protected-backup.json
```

The CLI validates the complete snapshot, checks the matching schema and inventory relationships, restores in one transaction, and runs SQLite integrity verification before reporting success.
