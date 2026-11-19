-- Look failed addresses up again: the geocoder now also tries the street without the
-- postcode filter, for new-build postcodes Google doesn't know yet (e.g. HP22 3DA).
UPDATE "orders" SET "geocode_status" = 'pending' WHERE "geocode_status" = 'failed' AND "lat" IS NULL;
