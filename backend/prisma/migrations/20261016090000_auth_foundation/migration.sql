-- Stage 4A: accounts, server-side sessions and audit events. No passwords are stored.

-- CreateEnum
CREATE TYPE "identity_pool" AS ENUM ('CUSTOMER', 'ADMIN');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('CUSTOMER', 'ADMIN');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "identity_pool" "identity_pool" NOT NULL,
    "identity_issuer" VARCHAR(255) NOT NULL,
    "identity_subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "display_name" VARCHAR(80),
    "role" "user_role" NOT NULL DEFAULT 'CUSTOMER',
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "kind" "identity_pool" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(40),
    "user_agent" VARCHAR(200),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_label" VARCHAR(120) NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "target_type" VARCHAR(40),
    "target_id" VARCHAR(64),
    "request_id" VARCHAR(128),
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_identity_issuer_identity_subject_key" ON "users"("identity_issuer", "identity_subject");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE INDEX "auth_sessions_absolute_expires_at_idx" ON "auth_sessions"("absolute_expires_at");

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_idx" ON "audit_events"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_events_target_type_target_id_idx" ON "audit_events"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written CHECK constraints (Prisma's schema language cannot express them).
-- ---------------------------------------------------------------------------

-- Privilege boundary: only identities from the admin pool can hold the ADMIN role, and admin-pool
-- accounts exist only as provisioned admins. A customer-pool identity can never be promoted, even
-- by a direct UPDATE of the role column.
ALTER TABLE "users" ADD CONSTRAINT "users_role_matches_identity_pool"
  CHECK (("identity_pool" = 'ADMIN') = ("role" = 'ADMIN'));
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase_format"
  CHECK ("email" = lower("email") AND "email" ~ '^[^@\s]+@[^@\s]+$');
ALTER TABLE "users" ADD CONSTRAINT "users_identity_not_blank"
  CHECK (btrim("identity_issuer") <> '' AND btrim("identity_subject") <> '');
ALTER TABLE "users" ADD CONSTRAINT "users_display_name_not_blank"
  CHECK ("display_name" IS NULL OR btrim("display_name") <> '');
ALTER TABLE "users" ADD CONSTRAINT "users_disabled_at_matches_status"
  CHECK (("status" = 'DISABLED') = ("disabled_at" IS NOT NULL));

-- Session timing is internally consistent, and a revocation always records why.
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_expiry_order"
  CHECK ("absolute_expires_at" > "created_at" AND "idle_expires_at" <= "absolute_expires_at");
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_revocation_complete"
  CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL));
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_token_hash_hex"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

-- Audit actions are upper-case verbs such as ADMIN_GRANTED.
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_format"
  CHECK ("action" ~ '^[A-Z][A-Z0-9_]{2,59}$');
