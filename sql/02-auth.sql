SET search_path TO health_memory, public;

CREATE TABLE IF NOT EXISTS app_users (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email          TEXT UNIQUE NOT NULL CHECK (position('@' in email) > 1),
    person_slug    TEXT REFERENCES persons(slug),
    role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active','pending','suspended')),
    created_by     TEXT,
    metadata       JSONB DEFAULT '{}'::jsonb,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT now(),
    updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email);
CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users(status);
CREATE INDEX IF NOT EXISTS idx_app_users_person_slug ON app_users(person_slug);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'touch_app_users'
    ) THEN
        CREATE TRIGGER touch_app_users
            BEFORE UPDATE ON app_users
            FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    END IF;
END $$;

INSERT INTO app_users (email, person_slug, role, status, created_by, metadata)
VALUES ('tareq@fc.sa', 'tareq', 'admin', 'active', 'migration', '{"seed":"admin"}'::jsonb)
ON CONFLICT (email) DO UPDATE
SET person_slug = excluded.person_slug,
    role = excluded.role,
    status = excluded.status,
    updated_at = now();

GRANT SELECT, INSERT, UPDATE ON app_users TO hmdb_app;

