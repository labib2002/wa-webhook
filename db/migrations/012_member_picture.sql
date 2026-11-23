-- =============================================================================
--  Migration 012: wa_lookup.members() also returns the member's picture from
--  the Byte+ app (employees.employee_image: {"url", "backgroundColor"}), so the
--  inbox can show it in place of the initials.
--
--  The pictures are already public on storage.bytepluslife.com; this hands the
--  inbox their address only for the numbers it asks about. wa_app still reaches
--  no platform table.
--
--  A function's result columns cannot be changed in place, so it is dropped and
--  made again in one transaction. Run as the backend's admin role, like 009.
--  Until this runs lib/members.js asks for the old columns and shows initials.
--  Rollback: run 009_member_lookup.sql again after
--    DROP FUNCTION wa_lookup.members(text[]);
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS wa_lookup.members(text[]);

CREATE FUNCTION wa_lookup.members(wa_ids text[])
RETURNS TABLE (wa_id text, source text, kind text, name text, company text, active boolean, image text, image_bg text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.wa_id, m.source, m.kind, m.name, m.company, m.active, m.image, m.image_bg
  FROM (
    SELECT wa_lookup.phone_key(o.phone) AS wa_id,
           'roster'::text AS source,
           'member'::text AS kind,
           coalesce(nullif(btrim(o.full_name_en), ''), nullif(btrim(o.full_name_ar), '')) AS name,
           c.name AS company,
           c.status <> 'churned' AS active,
           NULL::text AS image,
           NULL::text AS image_bg
      FROM public.ops_employees o
      JOIN public.ops_companies c ON c.id = o.company_id
    UNION ALL
    SELECT wa_lookup.phone_key(e.phone_number), 'app', 'member',
           coalesce(nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), ''),
                    nullif(btrim(concat_ws(' ', e.first_name_ar, e.last_name_ar)), '')),
           c.company_name,
           coalesce(lower(e.status) IN ('active', 'duck'), false),
           e.employee_image->>'url',
           e.employee_image->>'backgroundColor'
      FROM public.employees e
      JOIN public.companies c ON c.company_id = e.company_id
    UNION ALL
    SELECT wa_lookup.phone_key(k.phone), 'contact', k.kind::text, nullif(btrim(k.name), ''),
           c.name, c.status <> 'churned', NULL::text, NULL::text
      FROM public.ops_company_contacts k
      JOIN public.ops_companies c ON c.id = k.company_id
  ) m
  WHERE m.wa_id = ANY (wa_ids)
$$;

REVOKE ALL ON FUNCTION wa_lookup.members(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wa_lookup.members(text[]) TO wa_app;

COMMIT;
