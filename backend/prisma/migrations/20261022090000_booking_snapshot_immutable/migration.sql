-- Stage 4C follow-up: the product-name snapshot is immutable, like the price and currency snapshot.
-- 20261018090000_booking_foundation blocked changes to price_amount and currency but not product_name.
-- This replaces the trigger function only (same name, same trigger); the body is otherwise unchanged.
-- No data changes: the application never updates product_name.

CREATE OR REPLACE FUNCTION "bookings_check_target"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_product UUID;
  target_cohort UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
       OR NEW."session_id" IS DISTINCT FROM OLD."session_id" OR NEW."cohort_id" IS DISTINCT FROM OLD."cohort_id"
       OR NEW."price_amount" IS DISTINCT FROM OLD."price_amount" OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."product_name" IS DISTINCT FROM OLD."product_name"
       OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key" THEN
      RAISE EXCEPTION 'booking % : customer, target, product name, price, currency and reference cannot change', OLD."id" USING ERRCODE = '23514';
    END IF;
    IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
      RAISE EXCEPTION 'booking % : a cancelled booking cannot be reinstated', OLD."id" USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."session_id" IS NOT NULL THEN
    SELECT "product_id", "cohort_id" INTO target_product, target_cohort FROM "sessions" WHERE "id" = NEW."session_id";
    IF target_cohort IS NOT NULL THEN
      RAISE EXCEPTION 'online-training sessions are booked through their cohort' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "product_id" INTO target_product FROM "training_cohorts" WHERE "id" = NEW."cohort_id";
  END IF;
  IF target_product IS DISTINCT FROM NEW."product_id" THEN
    RAISE EXCEPTION 'booking product does not match its target' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
