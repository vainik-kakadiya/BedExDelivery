-- DSH-07: tell the API (LISTEN bedex_changes) that dashboard data changed.
-- Statement-level, so a bulk import or route edit sends one notification per
-- table, not one per row. Postgres also de-duplicates identical payloads
-- within a transaction and only delivers them on commit.
CREATE OR REPLACE FUNCTION public.bedex_notify_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  PERFORM pg_notify('bedex_changes', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_notify_change AFTER INSERT OR UPDATE OR DELETE ON public.orders
  FOR EACH STATEMENT EXECUTE FUNCTION public.bedex_notify_change();
--> statement-breakpoint
CREATE TRIGGER routes_notify_change AFTER INSERT OR UPDATE OR DELETE ON public.routes
  FOR EACH STATEMENT EXECUTE FUNCTION public.bedex_notify_change();
--> statement-breakpoint
CREATE TRIGGER route_stops_notify_change AFTER INSERT OR UPDATE OR DELETE ON public.route_stops
  FOR EACH STATEMENT EXECUTE FUNCTION public.bedex_notify_change();
--> statement-breakpoint
CREATE TRIGGER delivery_attempts_notify_change AFTER INSERT OR UPDATE OR DELETE ON public.delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.bedex_notify_change();
--> statement-breakpoint
CREATE TRIGGER driver_locations_notify_change AFTER INSERT ON public.driver_locations
  FOR EACH STATEMENT EXECUTE FUNCTION public.bedex_notify_change();
