-- Stage 4C: bookings. Additive only: new types, a new table, two new counter columns, constraints
-- and triggers. Existing rows are unaffected (counters start at 0; there are no bookings yet).
--
-- One booking = one seat for one customer account, on exactly one target:
--   * a standalone session (webinar or offline-workshop batch), or
--   * an online-training cohort (one booking covers both linked Friday sessions).
-- No payment exists yet: bookings start PENDING_PAYMENT and hold their seat until cancelled.

-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('PENDING_PAYMENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "booking_canceller" AS ENUM ('CUSTOMER', 'ADMIN');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "seats_held" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "training_cohorts" ADD COLUMN     "seats_held" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(16) NOT NULL,
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "session_id" UUID,
    "cohort_id" UUID,
    "status" "booking_status" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "price_amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "product_name" VARCHAR(160) NOT NULL,
    "contact_name" VARCHAR(100) NOT NULL,
    "phone_country" CHAR(2) NOT NULL,
    "phone_dialing_code" VARCHAR(4) NOT NULL,
    "phone_national" VARCHAR(15) NOT NULL,
    "phone_e164" VARCHAR(16) NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" "booking_canceller",
    "cancel_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_reference_key" ON "bookings"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_user_id_idempotency_key_key" ON "bookings"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "bookings_user_id_created_at_idx" ON "bookings"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "bookings_session_id_status_idx" ON "bookings"("session_id", "status");

-- CreateIndex
CREATE INDEX "bookings_cohort_id_status_idx" ON "bookings"("cohort_id", "status");

-- CreateIndex
CREATE INDEX "bookings_status_created_at_idx" ON "bookings"("status", "created_at");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "training_cohorts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints (Prisma's schema language cannot express them).
-- ---------------------------------------------------------------------------

-- Exactly one target: a session or a cohort, never both, never neither.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_exactly_one_target"
  CHECK (num_nonnulls("session_id", "cohort_id") = 1);

-- One active booking per customer per target (a cancelled booking does not block re-booking).
CREATE UNIQUE INDEX "bookings_one_active_per_user_session" ON "bookings"("user_id", "session_id")
  WHERE "status" = 'PENDING_PAYMENT' AND "session_id" IS NOT NULL;
CREATE UNIQUE INDEX "bookings_one_active_per_user_cohort" ON "bookings"("user_id", "cohort_id")
  WHERE "status" = 'PENDING_PAYMENT' AND "cohort_id" IS NOT NULL;

-- Price snapshot (exact decimal, ISO 4217, no tax) and display snapshot.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_price_amount_non_negative" CHECK ("price_amount" >= 0);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_currency_iso4217_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_reference_format" CHECK ("reference" ~ '^DF-[0-9A-Z]{8}$');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_names_not_blank" CHECK (btrim("product_name") <> '' AND btrim("contact_name") <> '');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_idempotency_key_format" CHECK ("idempotency_key" ~ '^[A-Za-z0-9_-]{16,64}$');

-- Phone: ISO country, dialing code and national digits stored separately, plus the normalized
-- E.164 number built from exactly those parts (so the dialing code can never be duplicated).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_phone_parts_format"
  CHECK ("phone_country" ~ '^[A-Z]{2}$' AND "phone_dialing_code" ~ '^[1-9][0-9]{0,3}$' AND "phone_national" ~ '^[0-9]{4,14}$');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_phone_e164_consistent"
  CHECK ("phone_e164" = '+' || "phone_dialing_code" || "phone_national" AND length("phone_dialing_code" || "phone_national") BETWEEN 8 AND 15);

-- Cancellation fields are set exactly when cancelled; an admin cancellation always has a reason.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancellation_consistent"
  CHECK ((("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)) AND (("status" = 'CANCELLED') = ("cancelled_by" IS NOT NULL)) AND ("cancel_reason" IS NULL OR "status" = 'CANCELLED'));
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_admin_cancel_has_reason"
  CHECK ("cancelled_by" IS DISTINCT FROM 'ADMIN' OR btrim(coalesce("cancel_reason", '')) <> '');

-- Seat counters can never go negative or above capacity. Under concurrent bookings the counter row is
-- locked by the update below, so the second transaction re-checks against the committed value.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_seats_held_within_capacity"
  CHECK ("seats_held" >= 0 AND ("capacity" IS NULL OR "seats_held" <= "capacity"));
ALTER TABLE "training_cohorts" ADD CONSTRAINT "training_cohorts_seats_held_within_capacity"
  CHECK ("seats_held" >= 0 AND ("capacity" IS NULL OR "seats_held" <= "capacity"));
-- Cohort sessions never hold seats themselves: the cohort does.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cohort_holds_no_seats"
  CHECK ("cohort_id" IS NULL OR "seats_held" = 0);

-- ---------------------------------------------------------------------------
-- Triggers: target validity, immutability, and the seat counters. The counters are changed ONLY
-- here, in the same transaction as the booking row, so they cannot drift from the bookings.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "bookings_check_target"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_product UUID;
  target_cohort UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
       OR NEW."session_id" IS DISTINCT FROM OLD."session_id" OR NEW."cohort_id" IS DISTINCT FROM OLD."cohort_id"
       OR NEW."price_amount" IS DISTINCT FROM OLD."price_amount" OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key" THEN
      RAISE EXCEPTION 'booking % : customer, target, price and reference cannot change', OLD."id" USING ERRCODE = '23514';
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

CREATE TRIGGER "bookings_check_target" BEFORE INSERT OR UPDATE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION "bookings_check_target"();

CREATE FUNCTION "bookings_maintain_seats"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta INTEGER := 0;
  row_ "bookings"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    row_ := NEW;
    IF NEW."status" = 'PENDING_PAYMENT' THEN delta := 1; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    row_ := OLD;
    IF OLD."status" = 'PENDING_PAYMENT' THEN delta := -1; END IF;
  ELSE
    row_ := NEW;
    IF OLD."status" = 'PENDING_PAYMENT' AND NEW."status" <> 'PENDING_PAYMENT' THEN delta := -1; END IF;
    IF OLD."status" <> 'PENDING_PAYMENT' AND NEW."status" = 'PENDING_PAYMENT' THEN delta := 1; END IF;
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

CREATE TRIGGER "bookings_maintain_seats" AFTER INSERT OR UPDATE OF "status" OR DELETE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION "bookings_maintain_seats"();
