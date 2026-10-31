-- GIMO backend schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS facilities (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  email        TEXT UNIQUE,
  phone        TEXT,
  contact_name TEXT,
  salt         TEXT,
  pass_hash    TEXT,
  token        TEXT,
  reset_token  TEXT,
  reset_expires INTEGER,
  created_at   INTEGER
);
-- On an existing database, add the reset columns once:
--   ALTER TABLE facilities ADD COLUMN reset_token TEXT;
--   ALTER TABLE facilities ADD COLUMN reset_expires INTEGER;
CREATE INDEX IF NOT EXISTS idx_fac_token ON facilities(token);
CREATE INDEX IF NOT EXISTS idx_fac_email ON facilities(email);

CREATE TABLE IF NOT EXISTS trips (
  id            TEXT PRIMARY KEY,
  facility_id   TEXT,
  facility_name TEXT,
  rider_name    TEXT,
  rider_phone   TEXT,
  pickup        TEXT,
  dropoff       TEXT,
  trip_date     TEXT,
  trip_time     TEXT,
  mobility      TEXT,
  round_trip    INTEGER DEFAULT 0,
  notes         TEXT,
  fare_estimate TEXT,
  status        TEXT DEFAULT 'requested',   -- requested | assigned | completed | cancelled
  driver        TEXT,
  vehicle       TEXT,
  pickup_eta    TEXT,
  created_at    INTEGER,
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trips_fac    ON trips(facility_id);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
CREATE INDEX IF NOT EXISTS idx_trips_created ON trips(created_at);

-- simple key/value settings (e.g. the Stripe payment link shown to riders & facilities)
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);
