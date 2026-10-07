// What a template message said, from the approved copy (lib/templates.js).
// Rows sent before 7 Oct only kept "📋 [name] p1 · p2" with no language; for
// those the language is guessed from the parameters (Arabic text -> ar).
// Loaded by the server (require) and by the inbox page (window.WaTpl).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WaTpl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEGACY_RE = /^📋 \[([^\]]+)\]\s*([\s\S]*)$/;
  const ARABIC_RE = /[؀-ۿ]/;

  function slotCount(text) {
    let max = 0;
    String(text || '').replace(/\{\{(\d+)\}\}/g, (_, n) => { max = Math.max(max, Number(n)); return ''; });
    return max;
  }

  function fill(text, params) {
    return String(text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => (params[n - 1] != null ? params[n - 1] : m));
  }

  function find(list, name, language) {
    const same = (list || []).filter((t) => t.name === name);
    const lang = String(language || '').toLowerCase();
    return same.find((t) => t.language.toLowerCase() === lang)
      || same.find((t) => t.language.toLowerCase().split('_')[0] === lang.split('_')[0])
      || same[0] || null;
  }

  function paramsOf(components, type) {
    const c = (components || []).find((x) => x.type === type);
    return c ? (c.parameters || []).map((p) => (p.type === 'text' ? p.text : '')) : [];
  }

  // -> { name, language, body: [..], header: [..] } or null
  function sentTemplate(m) {
    const meta = (m && m.media_meta) || {};
    if (meta.template && meta.template.name) {
      return {
        name: meta.template.name,
        language: meta.template.language,
        body: paramsOf(meta.template.components, 'body'),
        header: paramsOf(meta.template.components, 'header'),
      };
    }
    return parseLegacy(m && m.body);
  }

  function parseLegacy(text) {
    const hit = LEGACY_RE.exec(String(text || ''));
    if (!hit) return null;
    const rest = hit[2].trim();
    return { name: hit[1], language: ARABIC_RE.test(rest) ? 'ar' : 'en', body: rest ? rest.split(' · ') : [], header: [] };
  }

  // -> { name, language, header, body, footer, buttons } with parameters filled, or null
  function render(sent, list) {
    if (!sent) return null;
    const t = find(list, sent.name, sent.language);
    if (!t || !t.body) return null;
    let params = sent.body.slice();
    const slots = slotCount(t.body);
    // A legacy parameter that itself contained " · " was split in two.
    if (slots && params.length > slots) params = params.slice(0, slots - 1).concat(params.slice(slots - 1).join(' · '));
    return {
      name: t.name,
      language: t.language,
      header: fill(t.header, sent.header),
      body: fill(t.body, params),
      footer: t.footer || '',
      buttons: t.buttons || [],
    };
  }

  // Plain text of a message for previews and forwarding.
  function messageText(m, list) {
    const r = render(sentTemplate(m), list);
    return r ? [r.header, r.body].filter(Boolean).join('\n') : (m && m.body) || '';
  }

  // The chat list only stores the preview line, so legacy lines are rendered from it.
  function previewText(line, list) {
    const r = render(parseLegacy(line), list);
    return r ? `📋 ${r.body}` : line || '';
  }

  return { sentTemplate, render, messageText, previewText, fill, find };
});
