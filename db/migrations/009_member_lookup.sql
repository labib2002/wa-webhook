-- =============================================================================
--  Migration 009: wa_lookup.members(wa_ids text[])
--  Lets the inbox show which member, HR contact or coordinator a number
--  belongs to, and the company, without giving wa_app any platform table.
--
--  Run as the backend's admin role (it can read the ops and app tables),
--  NEVER as wa_app. The function runs with that role's rights, so:
--    - it lives in its own schema that wa_app can use but not change,
--    - search_path is pinned and every table is schema-qualified,
--    - it answers only for the wa_ids passed in, so the directory cannot be
--      listed, only probed number by number.
--  wa_app gets USAGE on the schema and EXECUTE on members(), nothing else.
--
--  phone_key() is the lenient mode of toWaId() in web/phone.js. Change both
--  together; scripts/member-lookup-check.js compares them.
--
--  Idempotent. Until this runs (or if it ever errors) the inbox shows no
--  company and keeps working. Rollback: DROP SCHEMA wa_lookup CASCADE;
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS wa_lookup;
REVOKE ALL ON SCHEMA wa_lookup FROM PUBLIC;

CREATE OR REPLACE FUNCTION wa_lookup.phone_key(raw text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN p.d ~ '^(20)?0?1[0-9]{9}$' AND NOT (p.plus AND p.d ~ '^1[0-9]{9}$') THEN '20' || right(p.d, 10)
           WHEN length(p.d) >= 8 THEN p.d
         END
  FROM (
    SELECT CASE WHEN q.d LIKE '00%' THEN substr(q.d, 3) ELSE q.d END AS d,
           q.plus OR q.d LIKE '00%' AS plus
    FROM (
      SELECT replace(s.v, '+', '') AS d, s.v LIKE '+%' AS plus
      FROM (
        SELECT regexp_replace(translate(raw, U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9', '01234567890123456789'), '[^0-9+]', '', 'g') AS v
      ) s
    ) q
  ) p
$$;

CREATE OR REPLACE FUNCTION wa_lookup.members(wa_ids text[])
RETURNS TABLE (wa_id text, source text, kind text, name text, company text, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.wa_id, m.source, m.kind, m.name, m.company, m.active
  FROM (
    SELECT wa_lookup.phone_key(o.phone) AS wa_id,
           'roster'::text AS source,
           'member'::text AS kind,
           coalesce(nullif(btrim(o.full_name_en), ''), nullif(btrim(o.full_name_ar), '')) AS name,
           c.name AS company,
           c.status <> 'churned' AS active
      FROM public.ops_employees o
      JOIN public.ops_companies c ON c.id = o.company_id
    UNION ALL
    SELECT wa_lookup.phone_key(e.phone_number), 'app', 'member',
           coalesce(nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), ''),
                    nullif(btrim(concat_ws(' ', e.first_name_ar, e.last_name_ar)), '')),
           c.company_name,
           coalesce(lower(e.status) IN ('active', 'duck'), false)
      FROM public.employees e
      JOIN public.companies c ON c.company_id = e.company_id
    UNION ALL
    SELECT wa_lookup.phone_key(k.phone), 'contact', k.kind::text, nullif(btrim(k.name), ''),
           c.name, c.status <> 'churned'
      FROM public.ops_company_contacts k
      JOIN public.ops_companies c ON c.id = k.company_id
  ) m
  WHERE m.wa_id = ANY (wa_ids)
$$;

REVOKE ALL ON FUNCTION wa_lookup.phone_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION wa_lookup.members(text[]) FROM PUBLIC;
GRANT USAGE ON SCHEMA wa_lookup TO wa_app;
GRANT EXECUTE ON FUNCTION wa_lookup.members(text[]) TO wa_app;
