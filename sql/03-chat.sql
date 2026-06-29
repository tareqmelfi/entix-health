SET search_path TO health_memory, public;

CREATE TABLE IF NOT EXISTS chat_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id       UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    title           TEXT NOT NULL DEFAULT 'New chat',
    summary         TEXT,
    pinned          BOOLEAN NOT NULL DEFAULT false,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_by      TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    last_message_at TIMESTAMPTZ DEFAULT now(),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_person_recent
    ON chat_sessions(person_id, pinned DESC, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_status
    ON chat_sessions(status);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    person_id   UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    body        TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
    ON chat_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_person_created
    ON chat_messages(person_id, created_at DESC);

CREATE TABLE IF NOT EXISTS report_snapshots (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id    UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    document_id  UUID REFERENCES documents(id) ON DELETE SET NULL,
    session_id   UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
    source_type  TEXT NOT NULL CHECK (source_type IN ('upload','pasted_text','manual')),
    report_kind  TEXT NOT NULL DEFAULT 'health_report',
    title        TEXT NOT NULL,
    report_date  DATE,
    summary      TEXT,
    metrics      JSONB DEFAULT '{}'::jsonb,
    trend        JSONB DEFAULT '{}'::jsonb,
    status       TEXT NOT NULL DEFAULT 'pending_classification'
                 CHECK (status IN ('pending_classification','classified','parser_pending')),
    created_by   TEXT,
    created_at   TIMESTAMPTZ DEFAULT now(),
    updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_snapshots_person_created
    ON report_snapshots(person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_snapshots_session
    ON report_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_report_snapshots_document
    ON report_snapshots(document_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'touch_chat_sessions'
    ) THEN
        CREATE TRIGGER touch_chat_sessions
            BEFORE UPDATE ON chat_sessions
            FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'touch_report_snapshots'
    ) THEN
        CREATE TRIGGER touch_report_snapshots
            BEFORE UPDATE ON report_snapshots
            FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON chat_sessions TO hmdb_app;
GRANT SELECT, INSERT, UPDATE ON chat_messages TO hmdb_app;
GRANT SELECT, INSERT, UPDATE ON report_snapshots TO hmdb_app;
