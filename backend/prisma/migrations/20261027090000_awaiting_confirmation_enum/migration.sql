-- Revision 3 (manual confirmation), part 1 of 2: the new booking status only.
-- PostgreSQL does not allow a value added by ALTER TYPE ... ADD VALUE to be used in the same
-- transaction, so everything that uses it follows in 20261027090100_manual_confirmation_cancellation_requests.
-- Additive: no existing row changes.

-- A booking request made in manual mode (the default): it holds a seat until staff confirm or decline it,
-- or until its confirmation deadline passes. Never paid, never a payment attempt.
ALTER TYPE "booking_status" ADD VALUE IF NOT EXISTS 'AWAITING_CONFIRMATION';
