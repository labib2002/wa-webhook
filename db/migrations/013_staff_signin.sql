-- =============================================================================
--  Migration 013: sign-in with the Byte+ staff account.
--
--  wa_lookup.staff(staff_id)        whether a staff account is still active and
--                                   which ops role it holds. The inbox asks it
--                                   every few minutes per signed-in person, so
--                                   removing or deactivating someone, or taking
--                                   their ops role away, ends their session.
--                                   It answers for one id at a time and returns
--                                   no name, email or password. wa_app still
--                                   reaches no platform table.
--  push_subscriptions.admin_id      the account signed in on the device. Only
--                                   devices tied to an account that still has
--                                   access get notifications.
--
--  push_subscriptions.pass_mark (migration 011) is no longer read or written.
--  It is left in place; drop it whenever convenient:
--    ALTER TABLE wa.push_subscriptions DROP COLUMN pass_mark;
--
--  Run as the backend's admin role (it can read admins and ops_admin_roles and
--  is a member of wa_app), like 009 and 012, NEVER as wa_app. Idempotent, and
--  safe to run before the release: the code in service ignores both pieces.
--  Until this runs, sign-in still works, a removed account keeps its session
--  until it expires, and notifications go to every device as before.
--  Rollback:
--    DROP FUNCTION wa_lookup.staff(integer);
--    ALTER TABLE wa.push_subscriptions DROP COLUMN admin_id;
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION wa_lookup.staff(staff_id integer)
RETURNS TABLE (active boolean, role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(a.is_active, false), r.role::text
    FROM public.admins a
    LEFT JOIN public.ops_admin_roles r ON r.admin_id = a.admin_id
   WHERE a.admin_id = staff_id
$$;

REVOKE ALL ON FUNCTION wa_lookup.staff(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wa_lookup.staff(integer) TO wa_app;

ALTER TABLE wa.push_subscriptions ADD COLUMN IF NOT EXISTS admin_id integer;

COMMIT;
