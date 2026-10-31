/*
 * GIMO API client — shared by the facility dashboard, partner signup and admin.
 *
 * After deploying backend/worker.js, set API_BASE to your Worker URL below
 * (e.g. 'https://gimo-backend.xxxx.workers.dev'). Leave it '' to keep the site
 * on its existing offline/email fallback — every page checks GIMOApi.configured()
 * and only uses the backend when a URL is set, so nothing breaks before deploy.
 *
 * The admin can also set the URL at runtime (no redeploy) via
 * GIMOApi.setBase('https://...'), which stores it in localStorage.
 */
(function () {
  var API_BASE = 'https://gimo-backend.gimo-9e1.workers.dev'; // GIMO shared backend (Cloudflare Worker + D1)

  try { var o = localStorage.getItem('gimo_api_base'); if (o) API_BASE = o; } catch (e) {}

  function configured() { return !!API_BASE; }
  function u(p) { return API_BASE.replace(/\/+$/, '') + p; }

  async function req(path, opts) {
    opts = opts || {};
    var r = await fetch(u(path), {
      method: opts.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((data && data.error) || ('Request failed (' + r.status + ')'));
    return data;
  }

  window.GIMOApi = {
    configured: configured,
    base: function () { return API_BASE; },
    setBase: function (b) {
      API_BASE = b || '';
      try { b ? localStorage.setItem('gimo_api_base', b) : localStorage.removeItem('gimo_api_base'); } catch (e) {}
    },
    health: function () { return req('/api/health'); },
    // public settings (e.g. Stripe pay link)
    getSettings: function () { return req('/api/settings'); },
    setSettings: function (key, obj) { return req('/api/admin/settings', { method: 'POST', headers: { 'X-Admin-Key': key }, body: obj }); },
    // facility accounts
    signup: function (d) { return req('/api/facility/signup', { method: 'POST', body: d }); },
    login: function (d) { return req('/api/facility/login', { method: 'POST', body: d }); },
    forgot: function (d) { return req('/api/facility/forgot', { method: 'POST', body: d }); },
    reset: function (d) { return req('/api/facility/reset', { method: 'POST', body: d }); },
    // trips (facility — Bearer token)
    createTrip: function (token, d) { return req('/api/trips', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: d }); },
    myTrips: function (token) { return req('/api/trips', { headers: { Authorization: 'Bearer ' + token } }); },
    // admin (X-Admin-Key)
    adminTrips: function (key, status) { return req('/api/admin/trips' + (status ? ('?status=' + encodeURIComponent(status)) : ''), { headers: { 'X-Admin-Key': key } }); },
    adminFacilities: function (key) { return req('/api/admin/facilities', { headers: { 'X-Admin-Key': key } }); },
    adminDeleteFacility: function (key, id) { return req('/api/admin/facilities/' + encodeURIComponent(id) + '/delete', { method: 'POST', headers: { 'X-Admin-Key': key } }); },
    assign: function (key, id, d) { return req('/api/admin/trips/' + encodeURIComponent(id) + '/assign', { method: 'POST', headers: { 'X-Admin-Key': key }, body: d }); },
  };
})();
