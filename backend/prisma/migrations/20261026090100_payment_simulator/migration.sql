-- Stage 2: payment attempts (development simulator only), CONFIRMED bookings and the 30-minute
-- payment hold. Additive: new types, a new table, two new nullable booking columns, and replaced
-- trigger functions / partial indexes (same names). No existing row is changed:
--   * existing bookings keep payment_due_at = NULL. They are GRANDFATHERED: they never get a deadline
--     (payment_due_at cannot change after insert) and can never be expired by the system (a SYSTEM
--     cancellation requires a deadline that has passed). Every NEW booking must have a deadline.
--   * no booking is CONFIRMED yet, so confirmed_at is NULL everywhere.
-- Simulated payments are not real money: provider DEV_SIMULATOR is always is_simulated = true.
-- Uses the enum values added by 20261026090000_payment_states_enum (committed separately).

-- CreateEnum
CREATE TYPE "payment_attempt_status" AS ENUM ('CREATED', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "payment_provider" AS ENUM ('DEV_SIMULATOR');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN     "payment_due_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "provider" "payment_provider" NOT NULL,
    "is_simulated" BOOLEAN NOT NULL,
    "status" "payment_attempt_status" NOT NULL DEFAULT 'CREATED',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "failure_reason" VARCHAR(200),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_attempts_booking_id_created_at_idx" ON "payment_attempts"("booking_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_booking_id_idempotency_key_key" ON "payment_attempts"("booking_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints (Prisma's schema language cannot express them).
-- ---------------------------------------------------------------------------

-- Bookings: the payment deadline is exactly 30 minutes after creation (NULL only for grandfathered
-- bookings, enforced by the insert trigger below); confirmed_at is set exactly when CONFIRMED.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_due_30_minutes"
  CHECK ("payment_due_at" IS NULL OR "payment_due_at" = "created_at" + interval '30 minutes');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmation_consistent"
  CHECK (("status" = 'CONFIRMED') = ("confirmed_at" IS NOT NULL));

-- One active (seat-holding) booking per customer per target: CONFIRMED now counts as active too.
-- Same index names as 20261018090000_booking_foundation (the application maps them to ALREADY_BOOKED).
DROP INDEX "bookings_one_active_per_user_session";
DROP INDEX "bookings_one_active_per_user_cohort";
CREATE UNIQUE INDEX "bookings_one_active_per_user_session" ON "bookings"("user_id", "session_id")
  WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED') AND "session_id" IS NOT NULL;
CREATE UNIQUE INDEX "bookings_one_active_per_user_cohort" ON "bookings"("user_id", "cohort_id")
  WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED') AND "cohort_id" IS NOT NULL;

-- The expiry sweep looks up overdue holds by deadline.
CREATE INDEX "bookings_pending_payment_due_at_idx" ON "bookings"("payment_due_at")
  WHERE "status" = 'PENDING_PAYMENT' AND "payment_due_at" IS NOT NULL;

-- Payment attempts: amount snapshot, simulator flag, completion fields, key format.
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_amount_non_negative" CHECK ("amount" >= 0);
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_currency_iso4217_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_simulator_is_simulated"
  CHECK (("provider" = 'DEV_SIMULATOR') = "is_simulated");
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_completion_consistent"
  CHECK ((("status" = 'CREATED') = ("completed_at" IS NULL)) AND ("failure_reason" IS NULL OR "status" IN ('FAILED', 'CANCELLED')));
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_idempotency_key_format"
  CHECK ("idempotency_key" ~ '^[A-Za-z0-9_-]{16,64}$');

-- At most one successful attempt per booking, and at most one open (CREATED) attempt at a time.
CREATE UNIQUE INDEX "payment_attempts_one_succeeded_per_booking" ON "payment_attempts"("booking_id") WHERE "status" = 'SUCCEEDED';
CREATE UNIQUE INDEX "payment_attempts_one_open_per_booking" ON "payment_attempts"("booking_id") WHERE "status" = 'CREATED';

-- ---------------------------------------------------------------------------
-- Triggers. Replaced functions keep their names and existing triggers; new ones are added.
-- ---------------------------------------------------------------------------

-- Booking validity and state machine (replaces the 20261022090000 body; earlier rules unchanged):
--   insert:  PENDING_PAYMENT only, always with a payment deadline;
--   update:  identity, snapshot and deadline fields are immutable; CANCELLED and CONFIRMED are final;
--            CONFIRMED only from PENDING_PAYMENT and only with a SUCCEEDED payment attempt;
--            a SYSTEM cancellation (expiry) only for a booking with a deadline that has passed.
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
       OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."payment_due_at" IS DISTINCT FROM OLD."payment_due_at" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'booking % : customer, target, product name, price, currency, reference and payment deadline cannot change', OLD."id" USING ERRCODE = '23514';
    END IF;
    IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
      RAISE EXCEPTION 'booking % : a cancelled booking cannot be reinstated', OLD."id" USING ERRCODE = '23514';
    END IF;
    IF OLD."status" = 'CONFIRMED' AND (NEW."status" <> 'CONFIRMED' OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at") THEN
      RAISE EXCEPTION 'booking % : a confirmed booking cannot be cancelled or returned to pending payment', OLD."id" USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'CONFIRMED' AND OLD."status" <> 'CONFIRMED' THEN
      IF NOT EXISTS (SELECT 1 FROM "payment_attempts" WHERE "booking_id" = NEW."id" AND "status" = 'SUCCEEDED') THEN
        RAISE EXCEPTION 'booking % : cannot be confirmed without a successful payment attempt', OLD."id" USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."cancelled_by" = 'SYSTEM' AND OLD."cancelled_by" IS DISTINCT FROM 'SYSTEM' THEN
      IF OLD."payment_due_at" IS NULL OR NEW."cancelled_at" < OLD."payment_due_at" THEN
        RAISE EXCEPTION 'booking % : only a booking whose payment deadline has passed can expire', OLD."id" USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" <> 'PENDING_PAYMENT' OR NEW."payment_due_at" IS NULL OR NEW."confirmed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a new booking must be PENDING_PAYMENT with a payment deadline' USING ERRCODE = '23514';
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

-- Seat counters (replaces the 20261018090000 body): a seat is held while PENDING_PAYMENT or CONFIRMED,
-- so PENDING_PAYMENT -> CONFIRMED changes nothing and expiry/cancellation releases exactly one seat.
CREATE OR REPLACE FUNCTION "bookings_maintain_seats"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta INTEGER := 0;
  row_ "bookings"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    row_ := NEW;
    IF NEW."status" IN ('PENDING_PAYMENT', 'CONFIRMED') THEN delta := 1; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    row_ := OLD;
    IF OLD."status" IN ('PENDING_PAYMENT', 'CONFIRMED') THEN delta := -1; END IF;
  ELSE
    row_ := NEW;
    IF OLD."status" IN ('PENDING_PAYMENT', 'CONFIRMED') AND NEW."status" NOT IN ('PENDING_PAYMENT', 'CONFIRMED') THEN delta := -1; END IF;
    IF OLD."status" NOT IN ('PENDING_PAYMENT', 'CONFIRMED') AND NEW."status" IN ('PENDING_PAYMENT', 'CONFIRMED') THEN delta := 1; END IF;
  END IF;

  IF delta <> 0 THEN
    IF row_."session_id" IS NOT NULL THEN
      UPDATE "sessions" SET "seats_held" = "seats_held" + delta WHERE "id" = row_."session_id";
    ELSE
      UPDATE "training_cohorts" SET "seats_held" = "seats_held" + delta WHERE "id" = row_."cohort_id";
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Payment attempts: created only for a PENDING_PAYMENT booking, with its exact amount and currency;
-- snapshot fields never change; CREATED -> SUCCEEDED | FAILED | CANCELLED once, then final; success only
-- while the booking is still PENDING_PAYMENT and inside its payment window. The booking row is read
-- FOR SHARE, so a concurrent cancellation or expiry of the booking is waited for and then seen.
CREATE FUNCTION "payment_attempts_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b "bookings"%ROWTYPE;
BEGIN
  SELECT * INTO b FROM "bookings" WHERE "id" = NEW."booking_id" FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'CREATED' THEN
      RAISE EXCEPTION 'a payment attempt starts as CREATED' USING ERRCODE = '23514';
    END IF;
    IF b."status" <> 'PENDING_PAYMENT' THEN
      RAISE EXCEPTION 'booking % : payment can only be started while the booking is pending payment', b."id" USING ERRCODE = '23514';
    END IF;
    IF NEW."amount" <> b."price_amount" OR NEW."currency" <> b."currency" THEN
      RAISE EXCEPTION 'booking % : payment amount and currency must match the booking snapshot', b."id" USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."booking_id" IS DISTINCT FROM OLD."booking_id" OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."is_simulated" IS DISTINCT FROM OLD."is_simulated" OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'payment attempt % : booking, provider, amount, currency and key cannot change', OLD."id" USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'CREATED' AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at" OR NEW."failure_reason" IS DISTINCT FROM OLD."failure_reason") THEN
    RAISE EXCEPTION 'payment attempt % : a completed attempt cannot change', OLD."id" USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'SUCCEEDED' AND OLD."status" <> 'SUCCEEDED' THEN
    IF b."status" <> 'PENDING_PAYMENT' OR (b."payment_due_at" IS NOT NULL AND NEW."completed_at" >= b."payment_due_at") THEN
      RAISE EXCEPTION 'booking % : payment can only succeed while the booking is pending payment and inside its payment window', b."id" USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_attempts_check" BEFORE INSERT OR UPDATE ON "payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "payment_attempts_check"();

-- Checked at COMMIT (deferred), so the attempt and the booking are always changed together:
--   * a SUCCEEDED attempt always belongs to a CONFIRMED booking;
--   * a booking that is no longer PENDING_PAYMENT has no open (CREATED) attempt.
CREATE FUNCTION "payment_attempts_succeeded_confirms_booking"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'SUCCEEDED' AND NOT EXISTS (SELECT 1 FROM "bookings" WHERE "id" = NEW."booking_id" AND "status" = 'CONFIRMED') THEN
    RAISE EXCEPTION 'payment attempt % : succeeded but its booking is not confirmed', NEW."id" USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payment_attempts_succeeded_confirms_booking" AFTER INSERT OR UPDATE ON "payment_attempts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "payment_attempts_succeeded_confirms_booking"();

CREATE FUNCTION "bookings_no_open_attempt_unless_pending"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'PENDING_PAYMENT' AND EXISTS (SELECT 1 FROM "payment_attempts" WHERE "booking_id" = NEW."id" AND "status" = 'CREATED') THEN
    RAISE EXCEPTION 'booking % : still has an open payment attempt', NEW."id" USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "bookings_no_open_attempt_unless_pending" AFTER UPDATE OF "status" ON "bookings"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "bookings_no_open_attempt_unless_pending"();
