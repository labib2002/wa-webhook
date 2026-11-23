// A stand-in for the two backend routes the inbox signs people in with, and
// for what wa_lookup.staff() answers. Used by every check; nothing here ever
// reaches a real backend.

const ACCOUNTS = () => ({
  'naglaa@byte.test': { password: 'demo', admin_id: 19, first_name: 'Naglaa', last_name: '', opsRole: 'ops' },
  'youssef@byte.test': { password: 'demo', admin_id: 21, first_name: 'Youssef', last_name: '', opsRole: 'ops' },
  'oufa@byte.test': { password: 'demo', admin_id: 22, first_name: 'Oufa', last_name: null, opsRole: 'super_admin' },
  'arabic@byte.test': { password: 'demo', admin_id: 23, first_name: 'Naglaa', last_name: 'ناجلاء', opsRole: 'ops' },
  'viewer@byte.test': { password: 'demo', admin_id: 30, first_name: 'View', last_name: 'Only', opsRole: 'viewer' },
  'norole@byte.test': { password: 'demo', admin_id: 31, first_name: 'Sajida', last_name: 'Nutrition', opsRole: null },
});

function makeFakeBackend(accounts = ACCOUNTS()) {
  const calls = [];
  const state = { down: false, limited: false };
  const answer = (status, body) => ({ status, json: async () => body });
  const byToken = (token) => Object.values(accounts).find((a) => `tok-${a.admin_id}` === token);

  async function fetchImpl(url, opts = {}) {
    const path = new URL(url).pathname;
    const headers = opts.headers || {};
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, method: opts.method || 'GET', headers, body });
    if (state.down) throw new Error('connect ECONNREFUSED');
    if (state.limited) return answer(429, { status: 429, message: 'Too many login attemps, please try again later.' });

    if (path === '/api/auth/v1/admins/login') {
      const acc = accounts[body.email];
      if (!acc || acc.active === false) return answer(401, { success: false, message: 'unauthorized access', errors: 'email_not_exists' });
      if (acc.password !== body.password) return answer(401, { success: false, message: 'unauthorized access', errors: 'invalid_email_or_password' });
      return answer(200, {
        success: true,
        message: 'admin logged in',
        data: {
          accessToken: `tok-${acc.admin_id}`,
          adminData: { admin_id: acc.admin_id, first_name: acc.first_name, last_name: acc.last_name, phone: '', email: body.email, role: 'viewer', ...('image' in acc ? { image: acc.image } : {}) },
        },
      });
    }
    if (path === '/api/ops/v1/me') {
      const acc = byToken(headers['x-admin-access-token']);
      if (!acc) return answer(401, { success: false, message: 'unauthorized access', errors: 'INVALID_TOKEN' });
      if (!acc.opsRole) return answer(403, { success: false, message: 'Unauthorized access', errors: 'FORBIDDEN' });
      return answer(200, { success: true, message: 'ok', data: { admin: { admin_id: acc.admin_id }, opsRole: acc.opsRole, features: {} } });
    }
    return answer(404, {});
  }

  async function lookup(adminId) {
    const acc = Object.values(accounts).find((a) => a.admin_id === Number(adminId));
    if (!acc) return null;
    const row = { active: acc.active !== false, role: acc.opsRole || null };
    if ('lookupImage' in acc) row.image = acc.lookupImage;
    return row;
  }

  return { fetchImpl, lookup, calls, state, accounts };
}

function install(accounts) {
  const staff = require('../lib/staff');
  const backend = makeFakeBackend(accounts);
  staff.__setBackendForTesting(backend.fetchImpl);
  staff.__setLookupForTesting(backend.lookup);
  return backend;
}

module.exports = { makeFakeBackend, install, EMAIL: 'naglaa@byte.test', PASSWORD: 'demo' };
