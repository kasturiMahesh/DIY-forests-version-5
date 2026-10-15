-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "product_type" AS ENUM ('ONLINE_TRAINING', 'OFFLINE_WORKSHOP', 'WEBINAR');

-- CreateEnum
CREATE TYPE "session_status" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "product_type" NOT NULL,
    "summary" TEXT,
    "description" TEXT,
    "audience" TEXT,
    "duration_label" VARCHAR(80),
    "price_amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    "capacity" INTEGER,
    "status" "session_status" NOT NULL DEFAULT 'DRAFT',
    "internal_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_type_is_active_idx" ON "products"("type", "is_active");

-- CreateIndex
CREATE INDEX "sessions_status_starts_at_idx" ON "sessions"("status", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_product_id_starts_at_key" ON "sessions"("product_id", "starts_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written CHECK constraints (Prisma's schema language cannot express them).
-- ---------------------------------------------------------------------------

-- Prices are exact, non-negative amounts in an explicit ISO 4217 currency (upper-case, 3 letters).
ALTER TABLE "products" ADD CONSTRAINT "products_price_amount_non_negative" CHECK ("price_amount" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_currency_iso4217_format" CHECK ("currency" ~ '^[A-Z]{3}$');
-- Slugs are lower-case kebab-case and names are not blank.
ALTER TABLE "products" ADD CONSTRAINT "products_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "products" ADD CONSTRAINT "products_name_not_blank" CHECK (btrim("name") <> '');

-- A session ends after it starts (when the end is known), holds at least one person, and names a timezone.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_ends_after_starts" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" > 0);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_timezone_not_blank" CHECK (btrim("timezone") <> '');

-- ---------------------------------------------------------------------------
-- Database default time zone = UTC.
-- Prisma 7.10's pg driver adapter sends DateTime values without a UTC offset and ignores the
-- offset when reading timestamptz back, so a non-UTC session time zone would silently store
-- shifted instants. Pin the database default so every new session (direct or pooled) is UTC.
-- Applies to sessions opened after this runs. Requires the migrating role to own the database
-- (true for Neon's default owner role and RDS's master user). See src/db/timezone-guard.ts.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END
$$;
