-- Retire the obsolete "Crash Course" and "Detailed Training" products. The website offers only
-- Online Training, Offline Workshop and Monthly Webinar.
--   * A retired product that nothing references is deleted.
--   * One that sessions or cohorts reference cannot be deleted (foreign keys RESTRICT) and must keep
--     its history, so it is archived instead: forced inactive and hidden from every product list and form.
-- audit_events.target_id is plain text (no foreign key), so past audit rows are kept either way.

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "archived_at" TIMESTAMPTZ(3);

-- An archived product can never be active (so it can never reach the public catalog).
ALTER TABLE "products" ADD CONSTRAINT "products_archived_inactive" CHECK ("archived_at" IS NULL OR "is_active" = false);

-- Delete the obsolete products where that is safe.
DELETE FROM "products" p
WHERE p."slug" IN ('crash-course', 'detailed-training')
  AND NOT EXISTS (SELECT 1 FROM "sessions" s WHERE s."product_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "training_cohorts" c WHERE c."product_id" = p."id");

-- Archive any that are still referenced.
UPDATE "products"
SET "is_active" = false, "archived_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" IN ('crash-course', 'detailed-training') AND "archived_at" IS NULL;
