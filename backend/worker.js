/*
 * GIMO Consulting Services — shared backend
 * Cloudflare Worker + D1 (SQLite). One database shared by:
 *   - the facility dashboard (accounts + trip requests)
 *   - the GIMO admin (trip queue + driver/pickup assignment)
 *
 * No secrets live in this file. The admin key is a Worker secret (ADMIN_KEY)
 * and the D1 database is bound as DB. See backend/DEPLOY.md.
 */

const ALLOW = [
  'https://gimocons.com',
  'https://www.gimocons.com',
  'https://nubridgemd1.github.io',
];
function corsHeaders(origin) {
  const ok = origin && ALLOW.some(a => origin === a);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOW[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const uid = () => crypto.randomUUID();
const makeToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');

// Email the facility (+ GIMO) when a trip is assigned, via FormSubmit — the same
// path the site already uses. Overridable with NOTIFY_TO / NOTIFY_CC env vars.
async function sendAssignmentEmail(env, trip) {
  try {
    const to = (env.NOTIFY_TO || 'gimocons@gmail.com').trim();
    const fac = await env.DB.prepare('SELECT email,name FROM facilities WHERE id=?').bind(trip.facility_id).first();
    const defaultCc = 'info@gimocons.com,onome.hunt@gimocons.com,noms_h@hotmail.com';
    const cc = [];
    if (fac && fac.email) cc.push(fac.email);
    (env.NOTIFY_CC != null ? env.NOTIFY_CC : defaultCc).split(',').map(s => s.trim()).filter(Boolean).forEach(x => cc.push(x));
    const ref = 'GF-' + String(trip.id || '').slice(0, 5).toUpperCase();
    const body = {
      _subject: 'GIMO trip ' + ref + ' — driver assigned (' + (trip.facility_name || '') + ')',
      _template: 'box',
      _cc: cc.join(','),
      Status: (trip.status || '').toUpperCase(),
      Reference: ref,
      Facility: trip.facility_name || '',
      Rider: trip.rider_name || '',
      Pickup: trip.pickup || '',
      Destination: trip.dropoff || '',
      Date: trip.trip_date || '',
      Pickup_Time: trip.trip_time || '',
      Driver: trip.driver || '(to be confirmed)',
      Vehicle: trip.vehicle || '(to be confirmed)',
      Pickup_ETA: trip.pickup_eta || '(to be confirmed)',
      Mobility: trip.mobility || '',
      Trip_Type: trip.round_trip ? 'Round trip' : 'One-way',
      Estimated_Fare: trip.fare_estimate || 'to be confirmed',
    };
    await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(to), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) { /* notification is best-effort; never block the assignment */ }
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');

    const facilityAuth = async () => {
      const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!tok) return null;
      return env.DB.prepare('SELECT * FROM facilities WHERE token=?').bind(tok).first();
    };
    const adminOk = () => {
      const k = req.headers.get('X-Admin-Key') || '';
      return !!env.ADMIN_KEY && k === env.ADMIN_KEY;
    };

    try {
      if (p === '/api/health' || p === '') {
        return json({ ok: true, service: 'gimo-backend', time: Date.now() }, 200, origin);
      }

      /* ---------------- Facility accounts ---------------- */
      if (p === '/api/facility/signup' && req.method === 'POST') {
        const b = await req.json();
        const email = (b.email || '').trim().toLowerCase();
        if (!email || !b.password) return json({ error: 'Email and password are required.' }, 400, origin);
        const existing = await env.DB.prepare('SELECT id FROM facilities WHERE email=?').bind(email).first();
        if (existing) return json({ error: 'An account already exists for that email — please sign in.' }, 409, origin);
        const id = uid(), salt = makeToken(), pass_hash = await sha256(salt + ':' + b.password), token = makeToken();
        await env.DB.prepare(
          'INSERT INTO facilities (id,name,email,phone,contact_name,salt,pass_hash,token,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(id, b.name || '', email, b.phone || '', b.contact || '', salt, pass_hash, token, Date.now()).run();
        return json({ id, token, name: b.name || '', email }, 200, origin);
      }

      if (p === '/api/facility/login' && req.method === 'POST') {
        const b = await req.json();
        const email = (b.email || '').trim().toLowerCase();
        const row = await env.DB.prepare('SELECT * FROM facilities WHERE email=?').bind(email).first();
        if (!row) return json({ error: 'No account found for that email.' }, 404, origin);
        const hash = await sha256(row.salt + ':' + (b.password || ''));
        if (hash !== row.pass_hash) return json({ error: 'Incorrect password.' }, 401, origin);
        const token = makeToken();
        await env.DB.prepare('UPDATE facilities SET token=? WHERE id=?').bind(token, row.id).run();
        return json({ id: row.id, token, name: row.name, email: row.email, phone: row.phone }, 200, origin);
      }

      /* ---------------- Trips (facility) ---------------- */
      if (p === '/api/trips' && req.method === 'POST') {
        const fac = await facilityAuth();
        if (!fac) return json({ error: 'Please sign in.' }, 401, origin);
        const b = await req.json();
        const id = uid(), now = Date.now();
        await env.DB.prepare(
          `INSERT INTO trips (id,facility_id,facility_name,rider_name,rider_phone,pickup,dropoff,trip_date,trip_time,mobility,round_trip,notes,fare_estimate,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          id, fac.id, fac.name, b.rider_name || '', b.rider_phone || '', b.pickup || '', b.dropoff || '',
          b.trip_date || '', b.trip_time || '', b.mobility || 'ambulatory', b.round_trip ? 1 : 0,
          b.notes || '', b.fare_estimate || '', 'requested', now, now
        ).run();
        const trip = await env.DB.prepare('SELECT * FROM trips WHERE id=?').bind(id).first();
        return json({ trip }, 200, origin);
      }

      if (p === '/api/trips' && req.method === 'GET') {
        const fac = await facilityAuth();
        if (!fac) return json({ error: 'Please sign in.' }, 401, origin);
        const { results } = await env.DB.prepare('SELECT * FROM trips WHERE facility_id=? ORDER BY created_at DESC').bind(fac.id).all();
        return json({ trips: results || [] }, 200, origin);
      }

      /* ---------------- Admin ---------------- */
      if (p === '/api/admin/trips' && req.method === 'GET') {
        if (!adminOk()) return json({ error: 'Unauthorized.' }, 401, origin);
        const status = url.searchParams.get('status');
        const q = status
          ? env.DB.prepare('SELECT * FROM trips WHERE status=? ORDER BY created_at DESC LIMIT 1000').bind(status)
          : env.DB.prepare('SELECT * FROM trips ORDER BY created_at DESC LIMIT 1000');
        const { results } = await q.all();
        return json({ trips: results || [] }, 200, origin);
      }

      if (p === '/api/admin/facilities' && req.method === 'GET') {
        if (!adminOk()) return json({ error: 'Unauthorized.' }, 401, origin);
        const { results } = await env.DB.prepare(
          'SELECT id,name,email,phone,contact_name,created_at FROM facilities ORDER BY created_at DESC'
        ).all();
        return json({ facilities: results || [] }, 200, origin);
      }

      const assign = p.match(/^\/api\/admin\/trips\/([^/]+)\/assign$/);
      if (assign && req.method === 'POST') {
        if (!adminOk()) return json({ error: 'Unauthorized.' }, 401, origin);
        const b = await req.json();
        await env.DB.prepare(
          'UPDATE trips SET driver=?, vehicle=?, pickup_eta=?, status=?, updated_at=? WHERE id=?'
        ).bind(b.driver || '', b.vehicle || '', b.pickup_eta || '', b.status || 'assigned', Date.now(), assign[1]).run();
        const trip = await env.DB.prepare('SELECT * FROM trips WHERE id=?').bind(assign[1]).first();
        if (!trip) return json({ error: 'Trip not found.' }, 404, origin);
        if (b.notify !== false && (trip.driver || (trip.status && trip.status !== 'requested'))) {
          if (ctx && ctx.waitUntil) ctx.waitUntil(sendAssignmentEmail(env, trip));
          else await sendAssignmentEmail(env, trip);
        }
        return json({ trip }, 200, origin);
      }

      return json({ error: 'Not found.' }, 404, origin);
    } catch (e) {
      return json({ error: 'Server error.', detail: String((e && e.message) || e) }, 500, origin);
    }
  },
};
