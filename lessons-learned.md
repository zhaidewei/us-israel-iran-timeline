# Lessons Learned

## 2026-03-07 — Vercel 500 (`FUNCTION_INVOCATION_FAILED`) while local worked

### What happened
- Local `make dev` worked, but production `GET /` returned 500.
- Vercel logs showed `Invalid export found in module "/var/task/server.js"` and `FUNCTION_INVOCATION_FAILED`.

### Root cause
- `server.js` (local Express entrypoint) was included in the Vercel deployment bundle.
- Vercel attempted to treat it as a serverless entrypoint for `/`, but it is not a valid Vercel function export.

### Fix applied
- Added [`.vercelignore`](./.vercelignore) to exclude `server.js` and local JSON data files from deployment.
- Updated [`vercel.json`](./vercel.json) to explicit static/API routing (`builds` + `routes`) so `/` always serves `public/index.html` and `/api/*` maps to function files.
- Added explicit routes for nested refresh endpoints:
  - `/api/polymarket/refresh` -> `/api/polymarket/refresh.js`
  - `/api/prices/refresh` -> `/api/prices/refresh.js`

### Prevention checklist
- Before deploy, verify:
  - `curl -I https://<domain>/` is `200`
  - `curl -I https://<domain>/api/events` is `200`
  - `curl -I https://<domain>/api/polymarket/refresh` is `200`
  - `curl -I https://<domain>/api/prices/refresh` is `200`
- Keep local-only entrypoints (`server.js`) and local data files out of serverless bundles.
- If using nested API folders, prefer explicit route mappings for critical endpoints.
