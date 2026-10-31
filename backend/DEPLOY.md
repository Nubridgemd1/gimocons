# GIMO backend — deploy to Cloudflare (step by step)

A Cloudflare **Worker** (the API) + a **D1** database (SQLite). Free tier covers
early volume. You do these steps once; after that the site talks to it live.

When you finish, you'll have a Worker URL like
`https://gimo-backend.<your-subdomain>.workers.dev`. **Send me that URL** and I'll
flip the site over to it (one line + push). Until then the site keeps working on
its current email/offline fallback — nothing breaks.

---

## Option A — Cloudflare dashboard (no command line)

1. **Create the database**
   - Cloudflare dashboard → **Storage & Databases → D1** → **Create database**.
   - Name it `gimo` → Create.

2. **Create the tables**
   - Open the `gimo` database → **Console** tab.
   - Open `backend/schema.sql`, copy all of it, paste into the console, **Run**.
   - You should see the `facilities` and `trips` tables created.

3. **Create the Worker**
   - **Workers & Pages → Create → Create Worker**.
   - Name it `gimo-backend` → Deploy (the placeholder) → **Edit code**.
   - Delete the sample, paste **all of `backend/worker.js`**, **Deploy**.

4. **Bind the database to the Worker**
   - Worker → **Settings → Bindings → Add → D1 database**.
   - Variable name: `DB`  ·  Database: `gimo`  → Save.

5. **Add the admin key (secret)**
   - Worker → **Settings → Variables and Secrets → Add → Secret**.
   - Name: `ADMIN_KEY`  ·  Value: a long random string you keep private
     (this is what the GIMO admin uses to read the trip queue). → Save & Deploy.

6. **Test it**
   - Visit `https://gimo-backend.<your-subdomain>.workers.dev/api/health`
   - You should see `{"ok":true,...}`.

7. **Send me the Worker URL** and the admin key (or just the URL — you can paste
   the key into the admin yourself). I'll wire the site to it and push.

---

## Option B — command line (wrangler)

```bash
npm install -g wrangler
wrangler login

# from the backend/ folder:
wrangler d1 create gimo
#   -> copy the printed database_id into wrangler.toml (database_id = "...")

wrangler d1 execute gimo --remote --file=schema.sql

wrangler secret put ADMIN_KEY
#   -> paste a long random string

wrangler deploy
#   -> prints the Worker URL; test <url>/api/health
```

---

## What the API exposes

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET  | `/api/health` | anyone | health check |
| POST | `/api/facility/signup` | facility | create account → `{id, token}` |
| POST | `/api/facility/login` | facility | sign in → `{id, token}` |
| POST | `/api/trips` | facility (Bearer token) | create a trip request |
| GET  | `/api/trips` | facility (Bearer token) | that facility's trips |
| GET  | `/api/admin/trips` | admin (`X-Admin-Key`) | full trip queue |
| GET  | `/api/admin/facilities` | admin (`X-Admin-Key`) | all facilities |
| POST | `/api/admin/trips/:id/assign` | admin (`X-Admin-Key`) | set driver/vehicle/ETA/status |

Security notes: passwords are stored salted + SHA‑256 hashed; facilities get a
bearer token on signup/login; the admin endpoints require the `ADMIN_KEY` secret.
CORS is locked to gimocons.com, www.gimocons.com and the GitHub Pages origin.
No secrets are in `worker.js` — they live only in the Worker's bindings/secrets.
