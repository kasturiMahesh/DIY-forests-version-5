-- Revision 3, part 2 of 2: manual confirmation, the confirmation deadline, cancellation requests and
-- refund ELIGIBILITY (never a processed refund: no payment provider exists). Additive: new types,
-- nullable booking columns, a new table, functions, and replaced trigger functions / constraints /
-- partial indexes under their existing names. NO existing row is updated or backfilled.
--
-- Clock convention (unchanged from Stage 2): every operation uses one API-server timestamp, written into
-- the row (created_at, confirmed_at, cancelled_at, requested_at); the triggers compare those stored values
-- with stored deadlines. In addition, confirmed_at and requested_at may not be more than 5 minutes older
-- than the database clock (clock_timestamp()), so a stale or back-dated time cannot slip a late
-- confirmation or a better refund tier past the database. This assumes the API and database clocks are
-- NTP-synchronized to well within 5 minutes.
--
-- Uses 'AWAITING_CONFIRMATION', added and committed by 20261027090000_awaiting_confirmation_enum.

-- ---------------------------------------------------------------------------
-- Compatibility guard. A CONFIRMED booking made before this migration has confirmed_at but no
-- confirmation_method, which the new rules would not accept. Rather than rewrite such rows, stop
-- (the whole migration rolls back) and report them so a decision can be made.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  legacy TEXT;
BEGIN
  SELECT string_agg("reference", ', ' ORDER BY "reference") INTO legacy
    FROM "bookings" WHERE "status" = 'CONFIRMED' OR "confirmed_at" IS NOT NULL;
  IF legacy IS NOT NULL THEN
    RAISE EXCEPTION 'Migration stopped: bookings confirmed before manual confirmation existed have no confirmation method: %. No data was changed.', legacy;
  END IF;
END
$$;

-- CreateEnum
CREATE TYPE "confirmation_method" AS ENUM ('PAYMENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "manual_confirmation_reason" AS ENUM ('PAYMENT_ARRANGED_OFFLINE', 'COMPLIMENTARY', 'OTHER');

-- CreateEnum
CREATE TYPE "cancellation_request_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "refund_policy" AS ENUM ('TRAINING_V1', 'WEBINAR_V1');

-- CreateEnum
CREATE TYPE "refund_outcome" AS ENUM ('NO_REFUND_SIMULATED_PAYMENT', 'NO_REFUND_COMPLIMENTARY', 'NOT_PROCESSED_BY_WEBSITE');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "confirmation_due_at" TIMESTAMPTZ(3),
ADD COLUMN     "confirmation_method" "confirmation_method",
ADD COLUMN     "confirmation_note" VARCHAR(500),
ADD COLUMN     "confirmation_reason" "manual_confirmation_reason",
ADD COLUMN     "confirmed_by_user_id" UUID;

-- CreateTable
CREATE TABLE "booking_cancellation_requests" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "customer_reason" VARCHAR(500),
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "refund_policy" "refund_policy" NOT NULL,
    "refund_percent" SMALLINT NOT NULL,
    "status" "cancellation_request_status" NOT NULL DEFAULT 'PENDING',
    "decided_by_user_id" UUID,
    "decision_reason" VARCHAR(500),
    "decided_at" TIMESTAMPTZ(3),
    "refund_outcome" "refund_outcome",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_cancellation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "booking_cancellation_requests_booking_id_requested_at_idx" ON "booking_cancellation_requests"("booking_id", "requested_at");

-- CreateIndex
CREATE INDEX "booking_cancellation_requests_status_requested_at_idx" ON "booking_cancellation_requests"("status", "requested_at");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmed_by_user_id_fkey" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_cancellation_requests" ADD CONSTRAINT "booking_cancellation_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_cancellation_requests" ADD CONSTRAINT "booking_cancellation_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_cancellation_requests" ADD CONSTRAINT "booking_cancellation_requests_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Booking constraints (row-local). Existing rows have NULL in every new column, so all of these hold.
-- ---------------------------------------------------------------------------

-- Replaces the Stage 2 rule "confirmed_at exactly when CONFIRMED": confirmation history (confirmed_at +
-- method) is set together, is required on CONFIRMED, and is kept when an approved cancellation request
-- cancels a confirmed booking. Whether a CANCELLED row may carry it is decided by the transition trigger.
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_confirmation_consistent";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmation_consistent"
  CHECK (("confirmed_at" IS NULL) = ("confirmation_method" IS NULL)
     AND ("status" <> 'CONFIRMED' OR "confirmed_at" IS NOT NULL)
     AND ("confirmed_at" IS NULL OR "status" IN ('CONFIRMED', 'CANCELLED')));

-- Manual-confirmation fields exist exactly for method MANUAL.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_manual_confirmation_fields"
  CHECK (CASE WHEN "confirmation_method" = 'MANUAL'
              THEN "confirmed_by_user_id" IS NOT NULL AND "confirmation_reason" IS NOT NULL
              ELSE "confirmed_by_user_id" IS NULL AND "confirmation_reason" IS NULL AND "confirmation_note" IS NULL END);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_other_reason_has_note"
  CHECK ("confirmation_reason" IS DISTINCT FROM 'OTHER' OR btrim(coalesce("confirmation_note", '')) <> '');

-- At most one deadline: payment (Stage 2) or confirmation (manual). Grandfathered bookings have none.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_one_deadline"
  CHECK (num_nonnulls("payment_due_at", "confirmation_due_at") <= 1);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_confirmation_due_48h"
  CHECK ("confirmation_due_at" IS NULL OR ("confirmation_due_at" > "created_at" AND "confirmation_due_at" <= "created_at" + interval '48 hours'));

-- One active (seat-holding) booking per customer per target: AWAITING_CONFIRMATION counts too.
-- Same names as before (the application maps them to ALREADY_BOOKED).
DROP INDEX "bookings_one_active_per_user_session";
DROP INDEX "bookings_one_active_per_user_cohort";
CREATE UNIQUE INDEX "bookings_one_active_per_user_session" ON "bookings"("user_id", "session_id")
  WHERE "status" IN ('PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED') AND "session_id" IS NOT NULL;
CREATE UNIQUE INDEX "bookings_one_active_per_user_cohort" ON "bookings"("user_id", "cohort_id")
  WHERE "status" IN ('PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED') AND "cohort_id" IS NOT NULL;

-- The expiry sweep looks up overdue confirmation holds by deadline.
CREATE INDEX "bookings_awaiting_confirmation_due_at_idx" ON "bookings"("confirmation_due_at")
  WHERE "status" = 'AWAITING_CONFIRMATION' AND "confirmation_due_at" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Cancellation-request constraints.
-- ---------------------------------------------------------------------------
ALTER TABLE "booking_cancellation_requests" ADD CONSTRAINT "booking_cancellation_requests_percent_valid"
  CHECK ("refund_percent" IN (0, 50, 100));
-- PENDING: no decision. APPROVED: decision + outcome. REJECTED: decision, no outcome.
ALTER TABLE "booking_cancellation_requests" ADD CONSTRAINT "booking_cancellation_requests_decision_consistent"
  CHECK ((("status" = 'PENDING') = ("decided_at" IS NULL))
     AND (("decided_at" IS NULL) = ("decided_by_user_id" IS NULL))
     AND (("decided_at" IS NULL) = ("decision_reason" IS NULL))
     AND ("decision_reason" IS NULL OR btrim("decision_reason") <> '')
     AND (("status" = 'APPROVED') = ("refund_outcome" IS NOT NULL)));
-- At most one pending request per booking.
CREATE UNIQUE INDEX "booking_cancellation_requests_one_pending" ON "booking_cancellation_requests"("booking_id")
  WHERE "status" = 'PENDING';

-- ---------------------------------------------------------------------------
-- Functions shared by the triggers (and mirrored in src/modules/bookings/refund-policy.ts).
-- ---------------------------------------------------------------------------

-- When a booking's offering starts: the session start, or the first session of a cohort.
CREATE FUNCTION "booking_target_start"(p_session UUID, p_cohort UUID) RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_session IS NOT NULL
              THEN (SELECT "starts_at" FROM "sessions" WHERE "id" = p_session)
              ELSE (SELECT "starts_at" FROM "sessions" WHERE "cohort_id" = p_cohort AND "cohort_sequence" = 1) END
$$;

-- Webinars use WEBINAR_V1; online training, offline workshops and any other (training) type use TRAINING_V1.
CREATE FUNCTION "refund_policy_for"(p_type "product_type") RETURNS "refund_policy" LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_type = 'WEBINAR' THEN 'WEBINAR_V1'::"refund_policy" ELSE 'TRAINING_V1'::"refund_policy" END
$$;

-- Eligibility percentage from the exact time remaining (epoch seconds, millisecond precision; no
-- calendar days). NULL at or after the start: online requests are not accepted then.
CREATE FUNCTION "refund_percent_for"(p_policy "refund_policy", p_start TIMESTAMPTZ, p_requested TIMESTAMPTZ) RETURNS SMALLINT LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE
    WHEN p_start <= p_requested THEN NULL
    WHEN p_policy = 'WEBINAR_V1' THEN 100
    WHEN extract(epoch FROM p_start - p_requested) >= 7 * 86400 THEN 100
    WHEN extract(epoch FROM p_start - p_requested) >= 3 * 86400 THEN 50
    ELSE 0 END)::SMALLINT
$$;

-- What the WEBSITE did about money when a confirmed booking is cancelled. Never "refunded": no provider
-- exists. Any other combination (e.g. a real, non-simulated payment) is refused until provider work exists.
CREATE FUNCTION "refund_outcome_for"(p_booking UUID) RETURNS "refund_outcome" LANGUAGE plpgsql STABLE AS $$
DECLARE
  b "bookings"%ROWTYPE;
BEGIN
  SELECT * INTO b FROM "bookings" WHERE "id" = p_booking;
  IF b."confirmation_method" = 'MANUAL' THEN
    IF b."confirmation_reason" = 'COMPLIMENTARY' THEN RETURN 'NO_REFUND_COMPLIMENTARY'; END IF;
    RETURN 'NOT_PROCESSED_BY_WEBSITE';
  END IF;
  IF b."confirmation_method" = 'PAYMENT'
     AND EXISTS (SELECT 1 FROM "payment_attempts" WHERE "booking_id" = p_booking AND "status" = 'SUCCEEDED' AND "is_simulated") THEN
    RETURN 'NO_REFUND_SIMULATED_PAYMENT';
  END IF;
  RAISE EXCEPTION 'booking % : no refund outcome is defined for this confirmation (real payments are not supported yet)', p_booking USING ERRCODE = '23514';
END;
$$;

-- ---------------------------------------------------------------------------
-- Booking state machine (replaces the 20261026090100 body; all earlier rules are kept).
--   insert:  AWAITING_CONFIRMATION with its exact confirmation deadline, or PENDING_PAYMENT with its
--            payment deadline; both only before the 24-hour cutoff; no confirmation/cancellation data.
--   update:  identity, snapshot and deadline fields immutable; CANCELLED final; confirmation history
--            written only on the transition into CONFIRMED and never changed afterwards;
--            AWAITING_CONFIRMATION -> CONFIRMED: method MANUAL by an active admin, before the deadline;
--            PENDING_PAYMENT -> CONFIRMED: method PAYMENT with a successful attempt;
--            CONFIRMED -> CANCELLED: only by ADMIN with an APPROVED cancellation request;
--            SYSTEM cancellation (expiry): only once the relevant deadline has passed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "bookings_check_target"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_product UUID;
  target_cohort UUID;
  target_start TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
       OR NEW."session_id" IS DISTINCT FROM OLD."session_id" OR NEW."cohort_id" IS DISTINCT FROM OLD."cohort_id"
       OR NEW."price_amount" IS DISTINCT FROM OLD."price_amount" OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."product_name" IS DISTINCT FROM OLD."product_name"
       OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."payment_due_at" IS DISTINCT FROM OLD."payment_due_at" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."confirmation_due_at" IS DISTINCT FROM OLD."confirmation_due_at" THEN
      RAISE EXCEPTION 'booking % : customer, target, product name, price, currency, reference and deadlines cannot change', OLD."id" USING ERRCODE = '23514';
    END IF;
    IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
      RAISE EXCEPTION 'booking % : a cancelled booking cannot be reinstated', OLD."id" USING ERRCODE = '23514';
    END IF;
    IF OLD."status" = 'CANCELLED' AND (NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at" OR NEW."cancelled_by" IS DISTINCT FROM OLD."cancelled_by"
       OR NEW."cancel_reason" IS DISTINCT FROM OLD."cancel_reason") THEN
      RAISE EXCEPTION 'booking % : a cancellation cannot be changed', OLD."id" USING ERRCODE = '23514';
    END IF;
    -- Leaving CONFIRMED: only cancellation by an admin through an approved request (checked before the
    -- history rule so the reason is reported accurately).
    IF OLD."status" = 'CONFIRMED' AND NEW."status" <> 'CONFIRMED' THEN
      IF NEW."status" <> 'CANCELLED' OR NEW."cancelled_by" IS DISTINCT FROM 'ADMIN'
         OR NOT EXISTS (SELECT 1 FROM "booking_cancellation_requests" WHERE "booking_id" = OLD."id" AND "status" = 'APPROVED') THEN
        RAISE EXCEPTION 'booking % : a confirmed booking cannot be cancelled or returned to pending payment except through an approved cancellation request', OLD."id" USING ERRCODE = '23514';
      END IF;
    END IF;
    -- Confirmation history: written only on the way into CONFIRMED, never edited or cleared afterwards.
    IF (NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at" OR NEW."confirmation_method" IS DISTINCT FROM OLD."confirmation_method"
        OR NEW."confirmed_by_user_id" IS DISTINCT FROM OLD."confirmed_by_user_id" OR NEW."confirmation_reason" IS DISTINCT FROM OLD."confirmation_reason"
        OR NEW."confirmation_note" IS DISTINCT FROM OLD."confirmation_note")
       AND NOT (NEW."status" = 'CONFIRMED' AND OLD."status" <> 'CONFIRMED') THEN
      RAISE EXCEPTION 'booking % : confirmation history is written only when a booking is confirmed and cannot change afterwards', OLD."id" USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'CONFIRMED' AND OLD."status" <> 'CONFIRMED' THEN
      IF OLD."status" = 'PENDING_PAYMENT' THEN
        IF NOT EXISTS (SELECT 1 FROM "payment_attempts" WHERE "booking_id" = NEW."id" AND "status" = 'SUCCEEDED') THEN
          RAISE EXCEPTION 'booking % : cannot be confirmed without a successful payment attempt', OLD."id" USING ERRCODE = '23514';
        END IF;
        IF NEW."confirmation_method" IS DISTINCT FROM 'PAYMENT' THEN
          RAISE EXCEPTION 'booking % : a payment confirmation must record method PAYMENT', OLD."id" USING ERRCODE = '23514';
        END IF;
      ELSIF OLD."status" = 'AWAITING_CONFIRMATION' THEN
        IF NEW."confirmation_method" IS DISTINCT FROM 'MANUAL' THEN
          RAISE EXCEPTION 'booking % : a booking awaiting confirmation can only be confirmed manually', OLD."id" USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."confirmed_by_user_id" AND "role" = 'ADMIN' AND "status" = 'ACTIVE' AND "identity_pool" = 'ADMIN') THEN
          RAISE EXCEPTION 'booking % : must be confirmed by an active administrator', OLD."id" USING ERRCODE = '23514';
        END IF;
        IF NEW."confirmed_at" IS NULL OR NEW."confirmed_at" >= OLD."confirmation_due_at" THEN
          RAISE EXCEPTION 'booking % : the confirmation deadline has passed', OLD."id" USING ERRCODE = '23514';
        END IF;
        IF NEW."confirmed_at" < clock_timestamp() - interval '5 minutes' THEN
          RAISE EXCEPTION 'booking % : the confirmation time is more than 5 minutes in the past', OLD."id" USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'booking % : cannot be confirmed from status %', OLD."id", OLD."status" USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED' AND NEW."cancelled_by" = 'SYSTEM' THEN
      IF NOT ((OLD."status" = 'PENDING_PAYMENT' AND OLD."payment_due_at" IS NOT NULL AND NEW."cancelled_at" >= OLD."payment_due_at")
           OR (OLD."status" = 'AWAITING_CONFIRMATION' AND OLD."confirmation_due_at" IS NOT NULL AND NEW."cancelled_at" >= OLD."confirmation_due_at")) THEN
        RAISE EXCEPTION 'booking % : only a booking whose payment or confirmation deadline has passed can expire', OLD."id" USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."status" IN ('PENDING_PAYMENT', 'AWAITING_CONFIRMATION') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'booking % : status cannot change from % to %', OLD."id", OLD."status", NEW."status" USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW."confirmed_at" IS NOT NULL OR NEW."confirmation_method" IS NOT NULL OR NEW."confirmed_by_user_id" IS NOT NULL
     OR NEW."confirmation_reason" IS NOT NULL OR NEW."confirmation_note" IS NOT NULL
     OR NOT ((NEW."status" = 'PENDING_PAYMENT' AND NEW."payment_due_at" IS NOT NULL AND NEW."confirmation_due_at" IS NULL)
          OR (NEW."status" = 'AWAITING_CONFIRMATION' AND NEW."confirmation_due_at" IS NOT NULL AND NEW."payment_due_at" IS NULL)) THEN
    RAISE EXCEPTION 'a new booking must be AWAITING_CONFIRMATION with a confirmation deadline or PENDING_PAYMENT with a payment deadline' USING ERRCODE = '23514';
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
  target_start := "booking_target_start"(NEW."session_id", NEW."cohort_id");
  IF target_start IS NULL OR NEW."created_at" >= target_start - interval '24 hours' THEN
    RAISE EXCEPTION 'bookings close 24 hours before the start' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'AWAITING_CONFIRMATION'
     AND NEW."confirmation_due_at" IS DISTINCT FROM least(NEW."created_at" + interval '48 hours', target_start - interval '24 hours') THEN
    RAISE EXCEPTION 'the confirmation deadline must be the earlier of 48 hours after booking and 24 hours before the start' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Seat counters (replaces the 20261026090100 body): PENDING_PAYMENT, AWAITING_CONFIRMATION and CONFIRMED
-- hold a seat, so confirmation never changes the counters and any cancellation/expiry releases one seat.
CREATE OR REPLACE FUNCTION "bookings_maintain_seats"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta INTEGER := 0;
  row_ "bookings"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    row_ := NEW;
    IF NEW."status" IN ('PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED') THEN delta := 1; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    row_ := OLD;
    IF OLD."status" IN ('PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED') THEN delta := -1; END IF;
  ELSE
    row_ := NEW;
    IF OLD."status" IN ('PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED') AND NEW."status" NOT IN ('PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED') THEN delta := -1; END IF;
    IF OLD."status" NOT IN ('PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED') AND NEW."status" IN ('PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED') THEN delta := 1; END IF;
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

-- ---------------------------------------------------------------------------
-- Cancellation requests. The booking row is read FOR SHARE, so a concurrent change to the booking is
-- waited for and then seen. The database recomputes the policy, percentage and outcome itself.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "booking_cancellation_requests_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b "bookings"%ROWTYPE;
  p_type "product_type";
  start_ TIMESTAMPTZ;
BEGIN
  SELECT * INTO b FROM "bookings" WHERE "id" = NEW."booking_id" FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'a cancellation request starts as PENDING' USING ERRCODE = '23514';
    END IF;
    IF b."status" IS DISTINCT FROM 'CONFIRMED' THEN
      RAISE EXCEPTION 'booking % : only a confirmed booking can have a cancellation request', NEW."booking_id" USING ERRCODE = '23514';
    END IF;
    IF NEW."requested_by_user_id" IS DISTINCT FROM b."user_id" THEN
      RAISE EXCEPTION 'booking % : only the customer who owns the booking can request its cancellation', b."id" USING ERRCODE = '23514';
    END IF;
    start_ := "booking_target_start"(b."session_id", b."cohort_id");
    IF NEW."requested_at" >= start_ THEN
      RAISE EXCEPTION 'booking % : a cancellation request must be made before the start', b."id" USING ERRCODE = '23514';
    END IF;
    IF NEW."requested_at" < clock_timestamp() - interval '5 minutes' THEN
      RAISE EXCEPTION 'booking % : the request time is more than 5 minutes in the past', b."id" USING ERRCODE = '23514';
    END IF;
    SELECT "type" INTO p_type FROM "products" WHERE "id" = b."product_id";
    IF NEW."refund_policy" IS DISTINCT FROM "refund_policy_for"(p_type)
       OR NEW."refund_percent" IS DISTINCT FROM "refund_percent_for"(NEW."refund_policy", start_, NEW."requested_at") THEN
      RAISE EXCEPTION 'booking % : refund policy or percentage does not match the policy at the request time', b."id" USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."booking_id" IS DISTINCT FROM OLD."booking_id" OR NEW."requested_by_user_id" IS DISTINCT FROM OLD."requested_by_user_id"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at" OR NEW."refund_policy" IS DISTINCT FROM OLD."refund_policy"
     OR NEW."refund_percent" IS DISTINCT FROM OLD."refund_percent" OR NEW."customer_reason" IS DISTINCT FROM OLD."customer_reason"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'cancellation request % : the request itself cannot change', OLD."id" USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'PENDING' AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."decided_by_user_id" IS DISTINCT FROM OLD."decided_by_user_id"
     OR NEW."decision_reason" IS DISTINCT FROM OLD."decision_reason" OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
     OR NEW."refund_outcome" IS DISTINCT FROM OLD."refund_outcome") THEN
    RAISE EXCEPTION 'cancellation request % : a decision is final', OLD."id" USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> OLD."status" THEN
    IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."decided_by_user_id" AND "role" = 'ADMIN' AND "status" = 'ACTIVE' AND "identity_pool" = 'ADMIN') THEN
      RAISE EXCEPTION 'cancellation request % : must be decided by an active administrator', OLD."id" USING ERRCODE = '23514';
    END IF;
    IF b."status" IS DISTINCT FROM 'CONFIRMED' THEN
      RAISE EXCEPTION 'cancellation request % : the booking is no longer confirmed', OLD."id" USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'APPROVED' AND NEW."refund_outcome" IS DISTINCT FROM "refund_outcome_for"(b."id") THEN
      RAISE EXCEPTION 'cancellation request % : refund outcome does not match the booking', OLD."id" USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "booking_cancellation_requests_check" BEFORE INSERT OR UPDATE ON "booking_cancellation_requests"
  FOR EACH ROW EXECUTE FUNCTION "booking_cancellation_requests_check"();

-- Checked at COMMIT (deferred): an APPROVED request's booking is CANCELLED by an admin in the same
-- transaction. Together with the booking rule "CONFIRMED -> CANCELLED only with an APPROVED request",
-- approval and cancellation can only ever commit together.
CREATE FUNCTION "booking_cancellation_requests_approved_cancels_booking"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM "bookings" WHERE "id" = NEW."booking_id" AND "status" = 'CANCELLED' AND "cancelled_by" = 'ADMIN') THEN
    RAISE EXCEPTION 'cancellation request % : approved but its booking was not cancelled', NEW."id" USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "booking_cancellation_requests_approved_cancels_booking" AFTER INSERT OR UPDATE ON "booking_cancellation_requests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "booking_cancellation_requests_approved_cancels_booking"();
