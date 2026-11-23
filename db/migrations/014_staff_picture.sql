-- =============================================================================
--  Migration 014: the signed-in person's picture.
--
--  wa_lookup.staff(staff_id) also returns the staff account's picture
--  (public.admins.image, added by the backend's migration 0101_admin_image),
--  so the inbox shows it next to the person's name and picks up a new one on
--  its next re-check. Still one id at a time, still no name, email or password.
--
--  Run AFTER the backend's 0101 (the function reads admins.image), as the
--  backend's admin role like 013, NEVER as wa_app. Idempotent. Until it runs
--  the inbox works as before: the picture comes from the sign-in answer only.
--  Rollback (back to 013's function):
--    DROP FUNCTION wa_lookup.staff(integer);
--    then run 013_staff_signin.sql again.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS wa_lookup.staff(integer);

CREATE FUNCTION wa_lookup.staff(staff_id integer)
RETURNS TABLE (active boolean, role text, image json)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(a.is_active, false), r.role::text, a.image
    FROM public.admins a
    LEFT JOIN public.ops_admin_roles r ON r.admin_id = a.admin_id
   WHERE a.admin_id = staff_id
$$;

REVOKE ALL ON FUNCTION wa_lookup.staff(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wa_lookup.staff(integer) TO wa_app;

COMMIT;
