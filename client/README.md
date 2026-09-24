# ZENENERGIES Station frontend

React, Vite, TypeScript, Tailwind CSS, React Router, Recharts, and Lucide frontend for the ZENENERGIES Station operations API.

## Local development

1. Run the backend from the repository root and configure its CORS origin for `http://localhost:5173`.
2. Copy `.env.example` to `.env.local` and adjust `VITE_DEV_PROXY_TARGET` if the backend is not on port 3000.
3. Run `npm install` and `npm run dev` in this directory.

`VITE_API_URL` defaults to `/api`. Vite proxies `/api` only during development. No secrets or tokens belong in Vite environment variables because browser variables are public.

## API contracts

`VITE_API_CONTRACT` defaults to `v2`, matching schema/API version 2. A legacy `v1` adapter remains available only for controlled migrations. The centralized adapter in `src/lib/stationApi.ts` owns response differences instead of leaking raw variants into pages:

- v2 Quick Tally sends the exact entered `amountKsh` and never estimates litres from the selling price.
- v2 detailed sales send server-validated `fuelId` and `pumpId` records.
- Pump readings send explicit `openingLitres`, `closingLitres`, and `prevClosingLitres`; sales readings send the corresponding KSh fields.
- v1 daily calendar aggregates and v2 event collections normalize into the same calendar-day model.
- Protected attendant fuel responses may omit prices; the adapter represents that as `null` rather than inventing a value.
- Responses missing required identifiers or financial totals are rejected rather than replaced with fabricated zeros.

Only Petrol and Diesel are exposed by the frontend.

## Production

Run `npm run build` and serve `dist/` from a static host. Configure a same-origin API route at `/api`, or set `VITE_API_URL` to an explicit HTTPS API origin before building. Configure the static host to route unknown frontend paths to `index.html` and to send CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and frame restrictions. The API remains responsible for authentication and authorization.

## Quality checks

- `npm run build`: strict TypeScript and production bundle with source maps disabled
- `npm test`: formatter, query, and validation unit tests

The app stores the short-lived access token and authenticated session only in `sessionStorage`. It never persists credentials beyond that browser tab. Appearance preferences can be retained locally; authoritative station settings are saved through the API by administrators.
