// The approved template copy, read from Meta so the inbox can show what a
// customer actually received instead of the template name and its parameters.

const tpl = require('../web/tpl');

const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, list: [] };
let inflight = null;

function textOf(components, type) {
  const c = (components || []).find((x) => x.type === type);
  if (!c || (c.format && c.format !== 'TEXT')) return '';
  return c.text || '';
}

function simplify(t) {
  const buttons = (t.components || []).find((x) => x.type === 'BUTTONS');
  return {
    name: t.name,
    language: t.language,
    header: textOf(t.components, 'HEADER'),
    body: textOf(t.components, 'BODY'),
    footer: textOf(t.components, 'FOOTER'),
    buttons: buttons ? (buttons.buttons || []).map((b) => b.text).filter(Boolean) : [],
  };
}

async function fetchAll() {
  const waba = process.env.WABA_ID;
  if (!waba || !process.env.WHATSAPP_TOKEN) return [];
  const version = process.env.GRAPH_API_VERSION || 'v23.0';
  let url = `https://graph.facebook.com/${version}/${waba}/message_templates?fields=name,language,status,components&limit=200`;
  const out = [];
  for (let page = 0; url && page < 10; page++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) throw new Error((data && data.error && data.error.message) || `HTTP ${resp.status}`);
    for (const t of data.data || []) out.push(simplify(t));
    url = data.paging && data.paging.next;
  }
  return out;
}

// Serves a stale list rather than nothing when Meta is unreachable.
async function listTemplates() {
  if (Date.now() - cache.at < TTL_MS) return cache.list;
  if (!inflight) {
    inflight = fetchAll()
      .then((list) => { cache = { at: Date.now(), list }; })
      .catch((e) => {
        console.warn('template list refresh failed:', e.message);
        cache = { at: Date.now() - TTL_MS + 60 * 1000, list: cache.list };
      })
      .finally(() => { inflight = null; });
  }
  await inflight;
  return cache.list;
}

// The cached list, refreshed in the background, so a send never waits on Meta.
function cached() {
  if (Date.now() - cache.at > TTL_MS) listTemplates();
  return cache.list;
}

function renderCached(name, language, components) {
  const r = tpl.render(tpl.sentTemplate({ media_meta: { template: { name, language, components } } }), cached());
  return r ? r.body : null;
}

function __setCacheForTesting(list) {
  cache = { at: list ? Date.now() : 0, list: list || [] };
}

module.exports = { listTemplates, cached, renderCached, __setCacheForTesting };
