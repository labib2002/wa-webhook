// Phone numbers in Meta's wa_id form: international digits, no '+'. Egypt is
// the default country, so 010 1234 5678, 10 1234 5678, +20 10 1234 5678,
// 0020 10 1234 5678 and +20 010 1234 5678 all become 201012345678.
// Loaded by the server (require) and by the inbox page (window.WaPhone).
// wa_lookup.phone_key in db/migrations/009_member_lookup.sql mirrors the
// lenient mode; scripts/member-lookup-check.js keeps the two in step.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WaPhone = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function asciiDigits(raw) {
    return String(raw == null ? '' : raw).replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (ch) => String(ch.charCodeAt(0) & 0xf));
  }

  function parts(raw) {
    const s = asciiDigits(raw).replace(/[^\d+]/g, '');
    let plus = s.startsWith('+');
    let d = s.replace(/\+/g, '');
    if (d.startsWith('00')) {
      d = d.slice(2);
      plus = true;
    }
    return { d, plus };
  }

  // lenient: for numbers a machine already formatted (the service route and the
  // stored roster phones). It only rescues Egyptian mobiles and otherwise keeps
  // the old digits-only rule, so nothing that worked before starts failing.
  function toWaId(raw, opts) {
    const { d, plus } = parts(raw);
    if (!d) return null;
    const mobile = /^(20)?(0)?(1\d{9})$/.exec(d);
    if (mobile && !(plus && !mobile[1] && !mobile[2])) return '20' + mobile[3];
    if (opts && opts.lenient) return d.length >= 8 ? d : null;
    const landline = /^(?:20|0|200)([2-9]\d{7,8})$/.exec(d);
    if (landline) return '20' + landline[1];
    if (d.startsWith('0') || d.startsWith('20') || d.length > 15) return null;
    if (plus) return d.length >= 7 ? d : null;
    return d.length >= 11 ? d : null;
  }

  function formatWaId(waId) {
    const d = String(waId == null ? '' : waId).replace(/\D/g, '');
    if (!d) return '';
    const eg = /^20(1\d)(\d{4})(\d{4})$/.exec(d);
    return eg ? `+20 ${eg[1]} ${eg[2]} ${eg[3]}` : '+' + d;
  }

  // Digit strings to look for inside a wa_id, so a search typed the local way
  // (010..., 0020...) still finds the stored 2010... number.
  function searchKeys(query) {
    const d = asciiDigits(query).replace(/\D/g, '');
    if (!d) return [];
    const keys = [d];
    if (d.startsWith('00')) keys.push(d.slice(2));
    else if (d.startsWith('0')) keys.push(d.slice(1));
    return keys.filter(Boolean);
  }

  return { toWaId, formatWaId, searchKeys };
});
