ALTER TABLE "routes" ADD COLUMN "planned_start" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "planned_end" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "polyline" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "routing_engine" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "changed_at" timestamp (3) with time zone;