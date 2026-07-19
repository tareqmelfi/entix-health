-- Migration: isolate legacy users that were incorrectly assigned to person_slug='tareq'
--
-- PROBLEM: Before the isolation fix, every new user was hardcoded to
-- person_slug='tareq' (the admin's profile). They saw Tareq's labs, medications,
-- and protocol — a critical privacy breach.
--
-- FIX: This script re-assigns each non-admin user to their OWN isolated person
-- record, derived from their email. Admin accounts keep 'tareq' (intentional).
--
-- Run once on production after deploying the isolation fix (commit 7bd3ba7+).
-- Idempotent: safe to re-run.

BEGIN;

-- 1) Create a person record for each non-admin user who was stuck on 'tareq'.
--    Slug format matches slugFromEmail(): u-<localpart>-<8-char-sha1>
INSERT INTO health_memory.persons (slug, display_label, relation_label, privacy_level, status, consent_recorded, metadata)
SELECT
  'u-' || left(regexp_replace(split_part(email, '@', 1), '[^a-z0-9-]+', '-', 'g'), 18)
    || '-' || substr(md5(lower(email)), 1, 8),
  split_part(email, '@', 1),
  'self',
  'private',
  'active',
  false,
  jsonb_build_object('source', 'migration-isolate-legacy', 'migrated_from', 'tareq', 'migrated_at', now())
FROM health_memory.app_users
WHERE person_slug = 'tareq'
  AND email NOT IN (
    -- admin emails (from ADMIN_GOOGLE_EMAILS config, default tareq@fc.sa)
    -- extend this list if you have more admins
    'tareq@fc.sa',
    'tareq@ensidex.com'
  )
  AND status = 'active'
ON CONFLICT (slug) DO UPDATE SET status = 'active', updated_at = now();

-- 2) Re-link each non-admin user to their own person slug.
UPDATE health_memory.app_users au
SET person_slug = 'u-' || left(regexp_replace(split_part(au.email, '@', 1), '[^a-z0-9-]+', '-', 'g'), 18)
    || '-' || substr(md5(lower(au.email)), 1, 8),
    updated_at = now()
WHERE au.person_slug = 'tareq'
  AND au.email NOT IN ('tareq@fc.sa', 'tareq@ensidex.com')
  AND au.status = 'active';

-- 3) Verify: count users still on 'tareq' (should be admins only)
SELECT email, role, status
FROM health_memory.app_users
WHERE person_slug = 'tareq'
ORDER BY email;

COMMIT;

-- NOTE: Existing sessions (cookies) carry the OLD slug='tareq' until they expire
-- (7 days maxAge) OR the user logs in again. The runtime safety net in
-- resolvePersonSlug() catches this: if session.slug='tareq' but session.email
-- is not an admin, it derives the correct slug on the fly. So affected users
-- are protected immediately, even before their cookie refreshes.
