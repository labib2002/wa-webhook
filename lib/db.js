// Postgres data layer. Presents the same chainable builder the app was written
// against (a small PostgREST subset) and compiles it to parameterized SQL over
// `pg`, so the 46 call sites and the whole test suite are unchanged.
//
// Contracts the rest of the app depends on, none of them optional:
//   - every call resolves to { data, error }; nothing here throws for a DB error
//   - error.code is the raw SQLSTATE. lib/idempotency.js keys dedupe on '23505'
//   - update()/insert() are LAZY: they run on await, or on .select().single()
//   - upsert() builds its DO UPDATE SET from the passed object's OWN keys, so a
//     row that omits profile_name never overwrites a stored one with null
//
// NEVER import this into anything that ships to the browser.

const pg = require('pg');
const { Pool } = pg;

// PostgREST served bigint as a JSON number; node-postgres returns a string to
// avoid losing precision past 2^53. The dashboard keys its dedupe Map on
// message id and branches on `typeof id === 'number'` (web/app.js), so the
// string would silently break bubble reconciliation. messages.id is nowhere
// near 2^53, so keep the number contract the client was written against.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const SCHEMA = () => process.env.WA_DB_SCHEMA || 'wa';
const IDENT = /^[a-z_][a-z0-9_]*$/i;

let pool = null;
let injected = null; // test/demo override

function __setDbForTesting(fake) {
  injected = fake;
}

function isConfigured() {
  if (injected) return true;
  return Boolean(process.env.DATABASE_URL);
}

function ident(name) {
  const n = String(name).trim();
  if (!IDENT.test(n)) throw new Error(`unsafe identifier: ${name}`);
  return `"${n}"`;
}

function qualified(table) {
  return `${ident(SCHEMA())}.${ident(table)}`;
}

// A connection-level failure leaves dead sockets in the pool after an Aurora
// failover; supabase-js's HTTP transport made that a non-issue. Retry those
// once, and only those — a constraint violation must never be retried.
const RETRYABLE = new Set(['57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004']);
function isRetryable(err) {
  if (!err) return false;
  if (RETRYABLE.has(err.code)) return true;
  return ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(err.code);
}

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    const err = new Error('Database is not configured. Set DATABASE_URL.');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Belt and braces with the schema-qualified table names. Sent as a startup
    // parameter rather than a SET on the 'connect' event, which would race the
    // first real query on that connection.
    options: `-c search_path=${SCHEMA()}`,
    // rds.force_ssl is 0 on this cluster, so TLS has to be asked for explicitly.
    ssl: process.env.DB_SSL === 'off' ? false : { rejectUnauthorized: false },
  });
  // Without this an idle-client error is an unhandled 'error' event and takes
  // the process down, which under PM2 is a restart loop.
  pool.on('error', (e) => console.error('pg pool error (idle client):', e.code || e.message));
  return pool;
}

async function runQuery(text, values) {
  const p = getPool();
  try {
    return await p.query(text, values);
  } catch (e) {
    if (!isRetryable(e)) throw e;
    console.warn('pg retrying after connection error:', e.code || e.message);
    return p.query(text, values);
  }
}

class Builder {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.cols = '*';
    this.rows = null;
    this.patch = null;
    this.conflict = null;
    this.ignoreDuplicates = false;
    this.increment = null;
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.countMode = false;
    this.headMode = false;
    this.returning = false;
    this.single_ = null;
  }

  // ---- writes ----
  insert(values) {
    this.op = 'insert';
    this.rows = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(values, opts = {}) {
    this.op = 'upsert';
    this.rows = Array.isArray(values) ? values : [values];
    this.conflict = opts.onConflict || null;
    this.ignoreDuplicates = Boolean(opts.ignoreDuplicates);
    // { unread_count: 1 } -> DO UPDATE SET unread_count = <table>.unread_count + 1,
    // which is the atomic form of the old read-then-write bump.
    this.increment = opts.increment || null;
    return this;
  }

  update(patch) {
    this.op = 'update';
    this.patch = patch;
    return this;
  }

  delete() {
    this.op = 'delete';
    return this;
  }

  // ---- select / returning ----
  // On a fresh builder this picks columns. After a write it means RETURNING,
  // exactly as the PostgREST client behaves.
  select(cols, opts = {}) {
    if (this.op === 'select') {
      if (cols) this.cols = cols;
      if (opts.count === 'exact') this.countMode = true;
      if (opts.head) this.headMode = true;
    } else {
      this.returning = true;
    }
    return this;
  }

  // ---- filters ----
  eq(col, val) { this.filters.push({ col, op: '=', val }); return this; }
  neq(col, val) { this.filters.push({ col, op: '<>', val }); return this; }
  gt(col, val) { this.filters.push({ col, op: '>', val }); return this; }
  gte(col, val) { this.filters.push({ col, op: '>=', val }); return this; }
  lt(col, val) { this.filters.push({ col, op: '<', val }); return this; }
  lte(col, val) { this.filters.push({ col, op: '<=', val }); return this; }
  in(col, vals) { this.filters.push({ col, op: 'in', val: vals }); return this; }

  // Only .not(col, 'is', null) is used, and only that form is accepted.
  not(col, op, val) {
    if (String(op).toLowerCase() !== 'is' || val !== null) {
      throw new Error(`unsupported .not(${col}, ${op}, ${val})`);
    }
    this.filters.push({ col, op: 'notnull' });
    return this;
  }

  order(col, opts = {}) {
    this.orders.push({
      col,
      ascending: opts.ascending !== false,
      nullsFirst: Boolean(opts.nullsFirst),
    });
    return this;
  }

  limit(n) { this.limitN = n; return this; }

  single() { this.single_ = 'single'; return this; }
  maybeSingle() { this.single_ = 'maybe'; return this; }

  // ---- SQL ----
  _where(vals) {
    if (!this.filters.length) return '';
    const parts = [];
    for (const f of this.filters) {
      if (f.op === 'notnull') { parts.push(`${ident(f.col)} IS NOT NULL`); continue; }
      if (f.op === 'in') {
        if (!f.val || !f.val.length) { parts.push('false'); continue; }
        vals.push(f.val);
        parts.push(`${ident(f.col)} = ANY($${vals.length})`);
        continue;
      }
      if (f.val === null) {
        parts.push(`${ident(f.col)} ${f.op === '=' ? 'IS' : 'IS NOT'} NULL`);
        continue;
      }
      vals.push(f.val);
      parts.push(`${ident(f.col)} ${f.op} $${vals.length}`);
    }
    return ` WHERE ${parts.join(' AND ')}`;
  }

  _orderLimit() {
    let sql = '';
    if (this.orders.length) {
      sql += ` ORDER BY ${this.orders
        .map((o) => `${ident(o.col)} ${o.ascending ? 'ASC' : 'DESC'} NULLS ${o.nullsFirst ? 'FIRST' : 'LAST'}`)
        .join(', ')}`;
    }
    if (this.limitN != null) sql += ` LIMIT ${parseInt(this.limitN, 10)}`;
    return sql;
  }

  _cols() {
    if (!this.cols || this.cols === '*') return '*';
    return String(this.cols)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .map(ident)
      .join(', ');
  }

  _build() {
    const vals = [];
    const t = qualified(this.table);

    if (this.op === 'select') {
      if (this.countMode && this.headMode) {
        return { text: `SELECT count(*)::int AS count FROM ${t}${this._where(vals)}`, values: vals };
      }
      return { text: `SELECT ${this._cols()} FROM ${t}${this._where(vals)}${this._orderLimit()}`, values: vals };
    }

    if (this.op === 'insert' || this.op === 'upsert') {
      // The column list is the union of the passed objects' OWN keys. A key that
      // is absent is never written, and on conflict is never overwritten.
      const keys = [];
      for (const r of this.rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
      if (this.increment) for (const k of Object.keys(this.increment)) if (!keys.includes(k)) keys.push(k);
      if (!keys.length) throw new Error(`${this.op} with no columns`);

      const tuples = this.rows.map((r) => {
        const ph = keys.map((k) => {
          if (this.increment && Object.prototype.hasOwnProperty.call(this.increment, k) && !(k in r)) {
            vals.push(this.increment[k]);
          } else {
            vals.push(r[k] === undefined ? null : r[k]);
          }
          return `$${vals.length}`;
        });
        return `(${ph.join(', ')})`;
      });

      let sql = `INSERT INTO ${t} (${keys.map(ident).join(', ')}) VALUES ${tuples.join(', ')}`;

      if (this.op === 'upsert' && this.conflict) {
        const target = String(this.conflict).split(',').map((c) => ident(c.trim())).join(', ');
        if (this.ignoreDuplicates) {
          sql += ` ON CONFLICT (${target}) DO NOTHING`;
        } else {
          const sets = keys.map((k) => {
            if (this.increment && Object.prototype.hasOwnProperty.call(this.increment, k)) {
              vals.push(this.increment[k]);
              return `${ident(k)} = ${t}.${ident(k)} + $${vals.length}`;
            }
            return `${ident(k)} = EXCLUDED.${ident(k)}`;
          });
          sql += ` ON CONFLICT (${target}) DO UPDATE SET ${sets.join(', ')}`;
        }
      }
      if (this.returning) sql += ' RETURNING *';
      return { text: sql, values: vals };
    }

    if (this.op === 'update') {
      const keys = Object.keys(this.patch || {});
      if (!keys.length) throw new Error('update with no columns');
      const sets = keys.map((k) => {
        vals.push(this.patch[k] === undefined ? null : this.patch[k]);
        return `${ident(k)} = $${vals.length}`;
      });
      let sql = `UPDATE ${t} SET ${sets.join(', ')}${this._where(vals)}`;
      if (this.returning) sql += ' RETURNING *';
      return { text: sql, values: vals };
    }

    if (this.op === 'delete') {
      let sql = `DELETE FROM ${t}${this._where(vals)}`;
      if (this.returning) sql += ' RETURNING *';
      return { text: sql, values: vals };
    }

    throw new Error(`unknown op ${this.op}`);
  }

  async _exec() {
    let res;
    try {
      const { text, values } = this._build();
      res = await runQuery(text, values);
    } catch (error) {
      // Hand the raw error back untouched. Stringifying it here would turn the
      // 23505 dedupe race into a silent double-send of a billable template.
      return { data: null, error, count: null };
    }

    if (this.op === 'select' && this.countMode && this.headMode) {
      return { data: null, error: null, count: res.rows[0] ? res.rows[0].count : 0 };
    }

    const rows = res.rows || [];
    if (this.single_ === 'maybe') return { data: rows[0] || null, error: null, count: rows.length };
    if (this.single_ === 'single') {
      if (rows.length === 1) return { data: rows[0], error: null, count: 1 };
      const error = Object.assign(
        new Error(rows.length ? 'multiple rows returned for .single()' : 'no rows returned for .single()'),
        { code: 'PGRST116' },
      );
      return { data: null, error, count: rows.length };
    }
    if (this.op !== 'select' && !this.returning) return { data: null, error: null, count: res.rowCount };
    return { data: rows, error: null, count: rows.length };
  }

  // Lazy: nothing runs until awaited. lib/templateSend.js returns the builder
  // unawaited so a caller can still chain .select().single() onto it.
  then(resolve, reject) {
    return this._exec().then(resolve, reject);
  }
  catch(fn) { return this._exec().catch(fn); }
}

function getDb() {
  if (injected) return injected;
  if (!isConfigured()) {
    const err = new Error('Database is not configured. Set DATABASE_URL.');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
  getPool();
  return client;
}

const storage = require('./storage');
const client = {
  from: (table) => new Builder(table),
  storage,
};

// Used by the boot probe and by scripts that need real SQL.
async function raw(text, values) {
  return runQuery(text, values);
}

// One pinned connection, for the multi-statement transaction the boot probe
// needs. pool.query() would spread those statements across connections.
async function withClient(fn) {
  const c = await getPool().connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

async function close() {
  if (pool) { const p = pool; pool = null; await p.end(); }
}

module.exports = { getDb, isConfigured, __setDbForTesting, raw, withClient, close, SCHEMA };
