-- Stage 2 (payment simulator), part 1 of 2: new enum values only.
-- PostgreSQL does not allow a value added by ALTER TYPE ... ADD VALUE to be used in the same
-- transaction, so the constraints, indexes and triggers that use these values follow in
-- 20261026090100_payment_simulator. Additive: no existing row changes.

-- A booking whose (simulated) payment succeeded. It keeps holding its seat and is final: it never
-- returns to PENDING_PAYMENT and cannot be cancelled until a refund policy exists.
ALTER TYPE "booking_status" ADD VALUE IF NOT EXISTS 'CONFIRMED';

-- Automatic expiry of an unpaid booking after its payment deadline.
ALTER TYPE "booking_canceller" ADD VALUE IF NOT EXISTS 'SYSTEM';
