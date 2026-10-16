-- Stage 4B: workshop venue and online-training cohorts (two linked Friday sessions).
-- Additive only: new nullable columns and a new table; existing rows are unaffected.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "cohort_id" UUID,
ADD COLUMN     "cohort_sequence" SMALLINT,
ADD COLUMN     "venue" VARCHAR(200);

-- CreateTable
CREATE TABLE "training_cohorts" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "status" "session_status" NOT NULL DEFAULT 'DRAFT',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    "capacity" INTEGER,
    "internal_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "training_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "training_cohorts_product_id_status_idx" ON "training_cohorts"("product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_cohort_id_cohort_sequence_key" ON "sessions"("cohort_id", "cohort_sequence");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "training_cohorts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_cohorts" ADD CONSTRAINT "training_cohorts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written CHECK constraints (Prisma's schema language cannot express them).
-- ---------------------------------------------------------------------------

-- A session is either standalone (both NULL) or session 1 or 2 of exactly one cohort.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cohort_fields_together"
  CHECK (("cohort_id" IS NULL) = ("cohort_sequence" IS NULL));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cohort_sequence_1_or_2"
  CHECK ("cohort_sequence" IS NULL OR "cohort_sequence" IN (1, 2));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_venue_not_blank"
  CHECK ("venue" IS NULL OR btrim("venue") <> '');

ALTER TABLE "training_cohorts" ADD CONSTRAINT "training_cohorts_capacity_positive"
  CHECK ("capacity" IS NULL OR "capacity" > 0);
ALTER TABLE "training_cohorts" ADD CONSTRAINT "training_cohorts_timezone_not_blank"
  CHECK (btrim("timezone") <> '');
