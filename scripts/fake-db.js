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
        for (const v of list) {
          let idx = -1;
          if (onConflict) idx = rows.findIndex((r) => r[onConflict] === v[onConflict]);
          if (idx > -1) {
            if (opts.ignoreDuplicates) continue; // keep existing
            rows[idx] = { ...rows[idx], ...v };
          } else {
            const row = { ...v };
            if (tableName === 'messages' && row.id == null) row.id = ++messageSeq;
            rows.push(row);
          }
        }
        return Promise.resolve({ data: null, error: null });
      },
      insert(values) {
        const list = Array.isArray(values) ? values : [values];
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
        // returns object with .eq(...) that applies the patch to matches
        return {
          eq(col, val) {
            for (const r of rows) if (r[col] === val) Object.assign(r, patch);
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      delete() {
        return {
          eq(col, val) {
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i][col] === val) rows.splice(i, 1);
            return Promise.resolve({ data: null, error: null });
          },
        };
      },

      // ---- read chain ----
      select() { return builder; },
      eq(col, val) { filters.push((r) => r[col] === val); return builder; },
      gt(col, val) { filters.push((r) => r[col] > val); return builder; },
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
        createSignedUrl: async () => ({ data: { signedUrl: '/_sample.svg' }, error: null }),
      };
    },
    listBuckets: async () => ({ data: [{ name: 'wa-media' }], error: null }),
    createBucket: async () => ({ data: null, error: null }),
  };

  return { from, storage, _tables: tables };
}

module.exports = { makeFakeDb };
