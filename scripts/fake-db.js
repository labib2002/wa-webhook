// A tiny in-memory stand-in for the Supabase client, implementing ONLY the
// query-builder methods our code actually uses. Lets the test suite verify the
// ingest/persist logic deterministically without a live database.
//
// Tables: { conversations: [...rows], messages: [...rows] }

function makeFakeDb() {
  const tables = { conversations: [], messages: [] };
  let messageSeq = 0;

  function from(tableName) {
    const rows = tables[tableName];

    // Builder state for select chains.
    const filters = [];
    let _order = [];
    let _limit = null;

    const builder = {
      // ---- writes ----
      upsert(values, opts = {}) {
        const list = Array.isArray(values) ? values : [values];
        const onConflict = opts.onConflict;
        const inc = opts.increment || null;
        // RETURNING semantics: DO UPDATE returns the row, DO NOTHING returns
        // nothing. lib/ingest.js uses exactly that to tell a first delivery
        // from a Meta retry.
        const returned = [];
        for (const v of list) {
          let idx = -1;
          if (onConflict) idx = rows.findIndex((r) => r[onConflict] === v[onConflict]);
          if (idx > -1) {
            if (opts.ignoreDuplicates) continue; // keep existing, return nothing
            rows[idx] = { ...rows[idx], ...v };
            // mirrors ON CONFLICT DO UPDATE SET col = table.col + n
            if (inc) for (const k of Object.keys(inc)) rows[idx][k] = (rows[idx][k] || 0) + inc[k];
            returned.push(rows[idx]);
          } else {
            const row = { ...v };
            if (inc) for (const k of Object.keys(inc)) if (row[k] == null) row[k] = inc[k];
            if (tableName === 'messages' && row.id == null) row.id = ++messageSeq;
            rows.push(row);
            returned.push(row);
          }
        }
        return {
          select: () => ({
            single: () => Promise.resolve({ data: returned[0] || null, error: returned.length ? null : { message: 'no rows' } }),
            maybeSingle: () => Promise.resolve({ data: returned[0] || null, error: null }),
            then: (res) => res({ data: returned, error: null }),
          }),
          then: (res) => res({ data: null, error: null }),
        };
      },
      insert(values) {
        const list = Array.isArray(values) ? values : [values];
        // messages.client_key is UNIQUE when present (migration 007) — the
        // reservation insert relies on losing this race with a 23505.
        const dup = list.find(
          (v) => tableName === 'messages' && v.client_key != null && rows.some((r) => r.client_key === v.client_key),
        );
        if (dup) {
          const error = { code: '23505', message: 'duplicate key value violates unique constraint' };
          return {
            select: () => ({
              single: () => Promise.resolve({ data: null, error }),
              maybeSingle: () => Promise.resolve({ data: null, error }),
            }),
            then: (res) => res({ data: null, error }),
          };
        }
        const inserted = [];
        for (const v of list) {
          const row = { ...v };
          if (tableName === 'messages' && row.id == null) row.id = ++messageSeq;
          rows.push(row);
          inserted.push(row);
        }
        // support .insert(...).select().single()
        return {
          select() {
            return {
              single: () => Promise.resolve({ data: inserted[0], error: null }),
              maybeSingle: () => Promise.resolve({ data: inserted[0] || null, error: null }),
            };
          },
          then: (res) => res({ data: inserted, error: null }),
        };
      },
      update(patch) {
        // .eq(...) applies the patch to matches and is awaitable on its own or
        // chainable into .select().single(), like the real builder.
        return {
          eq(col, val) {
            const hit = [];
            for (const r of rows) if (r[col] === val) { Object.assign(r, patch); hit.push(r); }
            return {
              select: () => ({
                single: () => Promise.resolve({ data: hit[0] || null, error: hit.length ? null : { message: 'no rows' } }),
                maybeSingle: () => Promise.resolve({ data: hit[0] || null, error: null }),
              }),
              then: (res) => res({ data: null, error: null }),
            };
          },
        };
      },

      // ---- read chain ----
      select() { return builder; },
      eq(col, val) { filters.push((r) => r[col] === val); return builder; },
      neq(col, val) { filters.push((r) => r[col] !== val); return builder; },
      gt(col, val) { filters.push((r) => r[col] > val); return builder; },
      gte(col, val) { filters.push((r) => r[col] >= val); return builder; },
      lt(col, val) { filters.push((r) => r[col] < val); return builder; },
      lte(col, val) { filters.push((r) => r[col] <= val); return builder; },
      in(col, vals) { filters.push((r) => (vals || []).includes(r[col])); return builder; },
      not(col, _op, _val) { filters.push((r) => r[col] != null); return builder; },
      order(col, opts = {}) { _order.push({ col, asc: opts.ascending !== false }); return builder; },
      limit(n) { _limit = n; return builder; },

      _resolve() {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        for (const o of [..._order].reverse()) {
          out.sort((a, b) => {
            const av = a[o.col], bv = b[o.col];
            if (av === bv) return 0;
            const cmp = av > bv ? 1 : -1;
            return o.asc ? cmp : -cmp;
          });
        }
        if (_limit != null) out = out.slice(0, _limit);
        return out;
      },
      maybeSingle() {
        const out = builder._resolve();
        return Promise.resolve({ data: out[0] || null, error: null });
      },
      single() {
        const out = builder._resolve();
        return Promise.resolve({ data: out[0] || null, error: out.length ? null : { message: 'no rows' } });
      },
      then(resolve) {
        const out = builder._resolve();
        return resolve({ data: out, error: null });
      },
    };
    return builder;
  }

  // Minimal storage stub (kept simple; the live storage round-trip is verified
  // separately). Screenshots exercise the placeholder + document UI, which need
  // no byte fetch.
  const storage = {
    from() {
      return {
        upload: async () => ({ data: { path: 'x' }, error: null }),
        remove: async () => ({ data: null, error: null }),
        download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(4) }, error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: '/_sample.svg' }, error: null }),
        measure: async () => ({ data: { bytes: 0, objects: 0 }, error: null }),
        listKeys: async () => ({ data: [], error: null }),
      };
    },
  };

  return { from, storage, _tables: tables };
}

module.exports = { makeFakeDb };
