CREATE TYPE "public"."attempt_outcome" AS ENUM('delivered', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."failure_reason" AS ENUM('not_home', 'wrong_address', 'refused', 'access_issue', 'damaged', 'missing_parts', 'van_issue', 'other');--> statement-breakpoint
CREATE TYPE "public"."geocode_status" AS ENUM('pending', 'ok', 'failed', 'manual');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('uploaded', 'mapped', 'committed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."issue_type" AS ENUM('damaged', 'missing_parts', 'other');--> statement-breakpoint
CREATE TYPE "public"."left_at_type" AS ENUM('customer', 'neighbour', 'safe_place');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('manual', 'import', 'shopify', 'migration');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('awaiting_scheduling', 'in_warehouse', 'scheduled', 'out_for_delivery', 'delivered', 'partially_delivered', 'failed', 'rescheduled', 'returned_to_warehouse', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."photo_type" AS ENUM('proof', 'issue');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'office', 'driver');--> statement-breakpoint
CREATE TYPE "public"."route_end_type" AS ENUM('depot', 'driver_home', 'last_stop');--> statement-breakpoint
CREATE TYPE "public"."route_status" AS ENUM('draft', 'released', 'in_progress', 'completed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attempt_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"type" "photo_type" NOT NULL,
	"taken_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"ip" text,
	"details" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"route_id" uuid,
	"driver_id" uuid,
	"attempt_no" integer NOT NULL,
	"outcome" "attempt_outcome" NOT NULL,
	"failure_reason" "failure_reason",
	"recipient_name" text,
	"left_at_type" "left_at_type",
	"left_at_note" text,
	"signature_path" text,
	"notes" text,
	"client_action_id" uuid,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "depots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"postcode" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_locations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"driver_id" uuid NOT NULL,
	"route_id" uuid,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"accuracy" double precision,
	"recorded_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"default_van_id" uuid,
	"work_start" time DEFAULT '08:00' NOT NULL,
	"work_end" time DEFAULT '17:00' NOT NULL,
	"max_hours" double precision DEFAULT 10 NOT NULL,
	"home_address" text,
	"home_postcode" text,
	"home_lat" double precision,
	"home_lng" double precision,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"status" "import_status" DEFAULT 'uploaded' NOT NULL,
	"mapping" jsonb,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_id" uuid,
	"type" "issue_type" NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_role" "user_role",
	"type" text NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status",
	"route_id" uuid,
	"driver_id" uuid,
	"note" text,
	"payload" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sku" text,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"delivered_qty" integer DEFAULT 0 NOT NULL,
	"units" double precision DEFAULT 1 NOT NULL,
	"weight_kg" double precision,
	"volume_m3" double precision
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"tracking_ref" text NOT NULL,
	"customer_id" uuid,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"customer_email" text,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"town" text NOT NULL,
	"postcode" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"geocode_status" "geocode_status" DEFAULT 'pending' NOT NULL,
	"time_window_start" time,
	"time_window_end" time,
	"service_minutes" integer DEFAULT 10 NOT NULL,
	"extra_minutes" integer DEFAULT 0 NOT NULL,
	"extra_reason" text,
	"requires_signature" boolean DEFAULT false NOT NULL,
	"access_instructions" text,
	"delivery_notes" text,
	"internal_notes" text,
	"status" "order_status" DEFAULT 'awaiting_scheduling' NOT NULL,
	"scheduled_date" date,
	"current_route_id" uuid,
	"cancel_reason" text,
	"source" "order_source" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"replaced_by_id" uuid,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "route_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"eta" timestamp (3) with time zone,
	"eta_window_ok" boolean,
	"arrived_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"depot_id" uuid NOT NULL,
	"end_type" "route_end_type" DEFAULT 'depot' NOT NULL,
	"driver_id" uuid,
	"van_id" uuid,
	"status" "route_status" DEFAULT 'draft' NOT NULL,
	"total_miles" double precision,
	"drive_minutes" integer,
	"total_minutes" integer,
	"optimised_at" timestamp (3) with time zone,
	"released_at" timestamp (3) with time zone,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"last_login_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration" text NOT NULL,
	"name" text NOT NULL,
	"capacity_units" double precision NOT NULL,
	"capacity_kg" double precision,
	"capacity_m3" double precision,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attempt_photos" ADD CONSTRAINT "attempt_photos_attempt_id_delivery_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."delivery_attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_locations" ADD CONSTRAINT "driver_locations_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_locations" ADD CONSTRAINT "driver_locations_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drivers" ADD CONSTRAINT "drivers_default_van_id_vans_id_fk" FOREIGN KEY ("default_van_id") REFERENCES "public"."vans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_templates" ADD CONSTRAINT "import_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_attempt_id_delivery_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."delivery_attempts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_current_route_id_routes_id_fk" FOREIGN KEY ("current_route_id") REFERENCES "public"."routes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routes" ADD CONSTRAINT "routes_depot_id_depots_id_fk" FOREIGN KEY ("depot_id") REFERENCES "public"."depots"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routes" ADD CONSTRAINT "routes_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routes" ADD CONSTRAINT "routes_van_id_vans_id_fk" FOREIGN KEY ("van_id") REFERENCES "public"."vans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attempt_photos_attempt_idx" ON "attempt_photos" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_phone_idx" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_attempts_order_attempt_unique" ON "delivery_attempts" USING btree ("order_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_attempts_client_action_unique" ON "delivery_attempts" USING btree ("client_action_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "depots_single_default" ON "depots" USING btree ("is_default") WHERE "depots"."is_default" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_locations_driver_time_idx" ON "driver_locations" USING btree ("driver_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_locations_recorded_idx" ON "driver_locations" USING btree ("recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drivers_user_unique" ON "drivers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_order_idx" ON "issues" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_events_order_created_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_order_number_unique" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_tracking_ref_unique" ON "orders" USING btree ("tracking_ref");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_source_external_unique" ON "orders" USING btree ("source","external_id") WHERE "orders"."external_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_postcode_idx" ON "orders" USING btree ("postcode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_date_idx" ON "orders" USING btree ("status","scheduled_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_current_route_idx" ON "orders" USING btree ("current_route_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_idx" ON "orders" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_customer_name_trgm" ON "orders" USING gin ("customer_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_address_trgm" ON "orders" USING gin ("address_line1" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_phone_trgm" ON "orders" USING gin ("customer_phone" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_hash_unique" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_stops_route_seq_idx" ON "route_stops" USING btree ("route_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "route_stops_route_order_unique" ON "route_stops" USING btree ("route_id","order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_stops_order_idx" ON "route_stops" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routes_date_idx" ON "routes" USING btree ("date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routes_driver_date_idx" ON "routes" USING btree ("driver_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_unique" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vans_registration_unique" ON "vans" USING btree ("registration");