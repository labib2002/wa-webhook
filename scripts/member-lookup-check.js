/* =============================================================================
   Check db/migrations/009_member_lookup.sql against a REAL Postgres: it
   compiles, wa_app can call members() but still cannot read a platform table,
   matching works across stored phone spellings, and phone_key() agrees with
   toWaId(raw, { lenient: true }) in web/phone.js.

   Run:  DATABASE_URL=postgres://<admin>@.../<scratch db> node scripts/member-lookup-check.js
   Point it at a SCRATCH database as a role that can create schemas and roles.
   It never reads .env, so it cannot pick up the box's live DATABASE_URL.
   Everything runs in one transaction that is rolled back.
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { toWaId } = require('../web/phone');

let failed = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); failed++; };
const eq = (got, want, m) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(`${m}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const PARITY = [
  '01012345678', '1012345678', '201012345678', '+201012345678', '00201012345678',
  '+20 010 1234 5678', '+2 010 1234 5678', '(+20) 101-234-5678', '\u0660\u0661\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668', '\u06f0\u06f1\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8',
  '\u202a+20 10 1234 5678\u202c', '+01012345678', '+1012345678', '2001012345678',
  '+447911123456', '447911123456', '0044 7911 123456', '3581234567', '0223456789',
  '12345', '1234567', '', '+', 'hello', '20 10 1234 567',
];

const SCAFFOLD = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wa_app') THEN CREATE ROLE wa_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ops_company_status') THEN CREATE TYPE ops_company_status AS ENUM ('pipeline','active','churned'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ops_contact_kind') THEN CREATE TYPE ops_contact_kind AS ENUM ('coordinator','hr'); END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.companies (company_id serial PRIMARY KEY, company_name text NOT NULL);
CREATE TABLE IF NOT EXISTS public.employees (
  employee_id serial PRIMARY KEY, company_id int NOT NULL, first_name text, last_name text,
  first_name_ar text, last_name_ar text, phone_number text NOT NULL DEFAULT '', status text);
CREATE TABLE IF NOT EXISTS public.ops_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name text NOT NULL,
  status ops_company_status NOT NULL DEFAULT 'pipeline');
CREATE TABLE IF NOT EXISTS public.ops_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, full_name_en text, full_name_ar text, phone text);
CREATE TABLE IF NOT EXISTS public.ops_company_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, kind ops_contact_kind NOT NULL, name text, phone text);
`;

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'off' ? false : undefined,
  });
  await c.connect();
  const migration = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '009_member_lookup.sql'), 'utf8');

  try {
    await c.query('BEGIN');
    await c.query(SCAFFOLD);
    await c.query(migration);

    console.log('\nPHONE KEY PARITY (SQL vs web/phone.js lenient)');
    for (const raw of PARITY) {
      const { rows } = await c.query('SELECT wa_lookup.phone_key($1) AS k', [raw]);
      eq(rows[0].k, toWaId(raw, { lenient: true }), `phone_key(${JSON.stringify(raw)})`);
    }

    const co = async (slug, name, status) =>
      (await c.query('INSERT INTO public.ops_companies (slug, name, status) VALUES ($1, $2, $3) RETURNING id', [slug, name, status])).rows[0].id;
    const app = async (name) =>
      (await c.query('INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id', [name])).rows[0].company_id;
    const degla = await co('zz-check-degla', 'ZZ Degla', 'active');
    const oasis = await co('zz-check-oasis', 'ZZ Oasis', 'churned');
    const appDegla = await app('ZZ Degla');
    const roster = (company, en, ar, phone) =>
      c.query('INSERT INTO public.ops_employees (company_id, full_name_en, full_name_ar, phone) VALUES ($1, $2, $3, $4)', [company, en, ar, phone]);
    const account = (company, first, last, phone, status) =>
      c.query('INSERT INTO public.employees (company_id, first_name, last_name, phone_number, status) VALUES ($1, $2, $3, $4, $5)', [company, first, last, phone, status]);

    await roster(degla, 'Ahmed Roster', null, '+201000000101');
    await account(appDegla, 'Ahmed', 'Ahmed', '201000000101', 'Active');
    await account(appDegla, 'Sara', 'App', '201000000102', 'duck');
    await account(appDegla, 'Old', 'Member', '201000000103', 'inActive');
    await c.query('INSERT INTO public.ops_company_contacts (company_id, kind, name, phone) VALUES ($1, $2, $3, $4)', [degla, 'hr', 'Mona HR', '01000000104']);
    await roster(oasis, 'Moved Person', null, '+201000000105');
    await account(appDegla, 'Moved', 'Person', '201000000105', 'Active');
    await roster(degla, '  ', 'سهر احمد', '+20 100 000 0106');

    console.log('\nPRIVILEGES (as wa_app)');
    await c.query('SET LOCAL ROLE wa_app');
    const ids = ['201000000101', '201000000102', '201000000103', '201000000104', '201000000105', '201000000106', '201000000199'];
    const { rows } = await c.query('SELECT wa_id, source, kind, name, company, active FROM wa_lookup.members($1::text[]) ORDER BY wa_id, source', [ids]);
    ok('wa_app can call wa_lookup.members()');
    for (const sql of ['SELECT 1 FROM public.employees LIMIT 1', 'SELECT 1 FROM public.ops_employees LIMIT 1', "SELECT wa_lookup.phone_key('1')"]) {
      await c.query('SAVEPOINT p');
      try {
        await c.query(sql);
        bad(`wa_app should be refused: ${sql}`);
      } catch (e) {
        eq(e.code, '42501', `wa_app is refused: ${sql}`);
      }
      await c.query('ROLLBACK TO SAVEPOINT p');
    }
    await c.query('RESET ROLE');

    console.log('\nMATCHING');
    const by = (id) => rows.filter((r) => r.wa_id === id).map((r) => `${r.source}:${r.kind}:${r.name}:${r.company}:${r.active}`);
    eq(by('201000000101'), ['app:member:Ahmed Ahmed:ZZ Degla:true', 'roster:member:Ahmed Roster:ZZ Degla:true'], 'roster and app account on one number both come back');
    eq(by('201000000102'), ['app:member:Sara App:ZZ Degla:true'], 'an app-only member matches');
    eq(by('201000000103'), ['app:member:Old Member:ZZ Degla:false'], 'an inactive account comes back inactive');
    eq(by('201000000104'), ['contact:hr:Mona HR:ZZ Degla:true'], 'an HR contact stored as 010... matches');
    eq(by('201000000105'), ['app:member:Moved Person:ZZ Degla:true', 'roster:member:Moved Person:ZZ Oasis:false'], 'a moved member shows both companies');
    eq(by('201000000106'), ['roster:member:سهر احمد:ZZ Degla:true'], 'a spaced +20 phone with an Arabic-only name matches');
    eq(by('201000000199'), [], 'an unknown number matches nothing');
  } catch (e) {
    bad(`unexpected error: ${e.message}`);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }

  console.log(failed ? `\n${failed} FAILED\n` : '\nall good\n');
  process.exit(failed ? 1 : 0);
})();
