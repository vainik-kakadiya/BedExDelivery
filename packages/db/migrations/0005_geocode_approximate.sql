ALTER TYPE "public"."geocode_status" ADD VALUE 'approximate' BEFORE 'failed';--> statement-breakpoint
-- Look failed addresses up again: the geocoder now falls back to the postcode and its district.
UPDATE "orders" SET "geocode_status" = 'pending' WHERE "geocode_status" = 'failed' AND "lat" IS NULL;
