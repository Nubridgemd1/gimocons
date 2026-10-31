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
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GIMO_CC = ['info@gimocons.com', 'onome.hunt@gimocons.com', 'noms_h@hotmail.com'];

// Send email via Resend when RESEND_API_KEY is set (reliable, branded, sends directly
// to the recipient). Falls back to FormSubmit (owner inbox + CC) if Resend isn't
// configured or errors. `to` = string or array; `cc` = array of strings.
async function sendEmail(env, { to, cc, subject, html, fields }) {
  const toArr = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const ccArr = (cc || []).filter(Boolean);
  if (env.RESEND_API_KEY) {
    try {
      const from = env.MAIL_FROM || 'GIMO Consulting Services <noreply@gimocons.com>';
      const body = { from, to: toArr, subject, html };
      if (ccArr.length) body.cc = ccArr;
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) return true; // otherwise fall through to FormSubmit
    } catch (e) { /* fall through */ }
  }
  try {
    const owner = (env.NOTIFY_TO || 'gimocons@gmail.com').trim();
    const fsBody = Object.assign({ _subject: subject, _template: 'box', _cc: toArr.concat(ccArr).join(',') }, fields || {});
    await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(owner), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Referer: 'https://gimocons.com/', Origin: 'https://gimocons.com' },
      body: JSON.stringify(fsBody),
    });
    return true;
  } catch (e) { return false; }
}

async function sendAssignmentEmail(env, trip) {
  const fac = await env.DB.prepare('SELECT email,name FROM facilities WHERE id=?').bind(trip.facility_id).first();
  const ref = 'GF-' + String(trip.id || '').slice(0, 5).toUpperCase();
  const cc = env.NOTIFY_CC != null ? env.NOTIFY_CC.split(',').map(s => s.trim()).filter(Boolean) : GIMO_CC;
  const row = (k, v) => `<tr><td style="padding:4px 14px 4px 0;color:#5a7080">${k}</td><td style="padding:4px 0;font-weight:600">${v || '—'}</td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#15303f">
    <h2 style="color:#0e2740;margin:0 0 2px">Driver assigned — ${esc(trip.facility_name || '')}</h2>
    <p style="color:#5a7080;margin:0 0 14px">Trip ${ref} · ${esc((trip.status || '').toUpperCase())}</p>
    <table style="font-size:14px;border-collapse:collapse">
      ${row('Rider', esc(trip.rider_name))}${row('Pickup', esc(trip.pickup))}${row('Destination', esc(trip.dropoff))}
      ${row('Date / time', esc((trip.trip_date || '') + ' ' + (trip.trip_time || '')))}${row('Mobility', esc(trip.mobility))}
      ${row('Driver', esc(trip.driver))}${row('Vehicle', esc(trip.vehicle))}${row('Pickup ETA', esc(trip.pickup_eta))}
      ${row('Estimated fare', esc(trip.fare_estimate))}
    </table>
    <p style="color:#5a7080;font-size:12px;margin-top:16px">GIMO Consulting Services · Non-Emergency Medical Transportation · (612) 483-1250</p>
  </div>`;
  return sendEmail(env, {
    to: (fac && fac.email) ? fac.email : (env.NOTIFY_TO || 'gimocons@gmail.com'),
    cc,
    subject: 'GIMO trip ' + ref + ' — driver assigned (' + (trip.facility_name || '') + ')',
    html,
    fields: { Reference: ref, Facility: trip.facility_name || '', Rider: trip.rider_name || '', Pickup: trip.pickup || '', Destination: trip.dropoff || '', Date: trip.trip_date || '', Pickup_Time: trip.trip_time || '', Driver: trip.driver || '(to be confirmed)', Vehicle: trip.vehicle || '(to be confirmed)', Pickup_ETA: trip.pickup_eta || '(to be confirmed)', Estimated_Fare: trip.fare_estimate || 'to be confirmed' },
  });
}

async function sendResetEmail(env, fac, link) {
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#15303f">
    <h2 style="color:#0e2740">Reset your password</h2>
    <p>Hello${fac.name ? ' ' + esc(fac.name) : ''},</p>
    <p>We received a request to reset the password for your GIMO facility account. Click the button below to choose a new password — this link expires in 1 hour.</p>
    <p><a href="${esc(link)}" style="display:inline-block;background:#1b8fd1;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold">Set a new password</a></p>
    <p style="color:#5a7080;font-size:13px">Or paste this link into your browser:<br><a href="${esc(link)}">${esc(link)}</a></p>
    <p style="color:#5a7080;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
    <p style="color:#5a7080;font-size:12px;margin-top:16px">GIMO Consulting Services · Non-Emergency Medical Transportation</p>
  </div>`;
  return sendEmail(env, {
    to: fac.email,
    cc: [(env.NOTIFY_TO || 'gimocons@gmail.com')],
    subject: 'Reset your GIMO facility password',
    html,
    fields: { Account_Email: fac.email || '', Reset_Link: link, Note: 'Open the reset link to set a new password. Expires in 1 hour.' },
  });
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

      /* ---------------- Public settings (e.g. Stripe pay link) ---------------- */
      if (p === '/api/settings' && req.method === 'GET') {
        const row = await env.DB.prepare("SELECT v FROM settings WHERE k='pay_link'").first();
        return json({ pay_link: (row && row.v) || '' }, 200, origin);
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

      if (p === '/api/facility/forgot' && req.method === 'POST') {
        const b = await req.json();
        const email = (b.email || '').trim().toLowerCase();
        const row = email ? await env.DB.prepare('SELECT id,name,email FROM facilities WHERE email=?').bind(email).first() : null;
        if (row) {
          const token = makeToken(), expires = Date.now() + 3600000; // 1 hour
          await env.DB.prepare('UPDATE facilities SET reset_token=?, reset_expires=? WHERE id=?').bind(token, expires, row.id).run();
          const base = (origin || 'https://gimocons.com').replace(/\/$/, '');
          const link = base + '/facility/?reset=' + token;
          if (ctx && ctx.waitUntil) ctx.waitUntil(sendResetEmail(env, row, link));
          else await sendResetEmail(env, row, link);
        }
        return json({ ok: true }, 200, origin); // generic — never reveal whether the email exists
      }

      if (p === '/api/facility/reset' && req.method === 'POST') {
        const b = await req.json();
        const token = (b.token || '').trim();
        if (!token || !b.password) return json({ error: 'Invalid request.' }, 400, origin);
        if (String(b.password).length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400, origin);
        const row = await env.DB.prepare('SELECT * FROM facilities WHERE reset_token=?').bind(token).first();
        if (!row || !row.reset_expires || row.reset_expires < Date.now())
          return json({ error: 'This reset link is invalid or has expired — please request a new one.' }, 400, origin);
        const salt = makeToken(), pass_hash = await sha256(salt + ':' + b.password), sess = makeToken();
        await env.DB.prepare('UPDATE facilities SET salt=?, pass_hash=?, token=?, reset_token=NULL, reset_expires=NULL WHERE id=?')
          .bind(salt, pass_hash, sess, row.id).run();
        return json({ id: row.id, token: sess, name: row.name, email: row.email, phone: row.phone }, 200, origin);
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

      if (p === '/api/admin/settings' && req.method === 'POST') {
        if (!adminOk()) return json({ error: 'Unauthorized.' }, 401, origin);
        const b = await req.json();
        await env.DB.prepare(
          "INSERT INTO settings (k,v) VALUES ('pay_link',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v"
        ).bind(b.pay_link || '').run();
        return json({ pay_link: b.pay_link || '' }, 200, origin);
      }

      const delFac = p.match(/^\/api\/admin\/facilities\/([^/]+)\/delete$/);
      if (delFac && req.method === 'POST') {
        if (!adminOk()) return json({ error: 'Unauthorized.' }, 401, origin);
        await env.DB.prepare('DELETE FROM trips WHERE facility_id=?').bind(delFac[1]).run();
        await env.DB.prepare('DELETE FROM facilities WHERE id=?').bind(delFac[1]).run();
        return json({ ok: true }, 200, origin);
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
