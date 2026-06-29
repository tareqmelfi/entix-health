-- ============================================================================
-- T-PER-DOC-HEALTH-POSTGRES-SCHEMA-EN-V01.sql
-- ============================================================================
-- T-OS Personal Health Brain · PostgreSQL Schema · V01
-- For: T-PER-HMDB-PG · health_memory schema
-- Version: V01 · 2026-05-26
-- DB: PostgreSQL 16+ (pgvector optional)
-- ============================================================================
-- This file is the source of truth for the health memory database schema.
-- Run via Prisma migrate OR psql direct.
-- ============================================================================


-- ============================================================================
-- 0 · EXTENSIONS + SCHEMA
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- pgvector: skipped at MVP. Enable when embedding search needed.
-- CREATE EXTENSION IF NOT EXISTS "vector";

CREATE SCHEMA IF NOT EXISTS health_memory;
SET search_path TO health_memory, public;


-- ============================================================================
-- 1 · PERSONS · profile registry
-- ============================================================================

CREATE TABLE IF NOT EXISTS persons (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug            TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
    display_label   TEXT NOT NULL,
    relation_label  TEXT,
    privacy_level   TEXT DEFAULT 'private',
    status          TEXT DEFAULT 'active' CHECK (status IN ('active','archived','suspended')),
    consent_recorded BOOLEAN DEFAULT FALSE,
    consent_date    TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_persons_slug ON persons(slug);
CREATE INDEX idx_persons_status ON persons(status);


-- ============================================================================
-- 2 · MEDICAL_CONDITIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS medical_conditions (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id         UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    condition_name    TEXT NOT NULL,
    status            TEXT,
    confidence_level  TEXT CHECK (confidence_level IN ('confirmed','suspected','pending_review','self_reported')),
    source            TEXT,
    notes             TEXT,
    created_by        TEXT,
    metadata          JSONB DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ DEFAULT now(),
    updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_conditions_person_status ON medical_conditions(person_id, status);
CREATE INDEX idx_conditions_metadata_gin ON medical_conditions USING gin(metadata);


-- ============================================================================
-- 3 · MEDICATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS medications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id       UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    medication_name TEXT NOT NULL,
    dose            TEXT,
    frequency       TEXT,
    timing          TEXT,
    status          TEXT DEFAULT 'active' CHECK (status IN ('active','discontinued','paused','as_needed')),
    prescribed_by   TEXT,
    start_date      DATE,
    end_date        DATE,
    notes           TEXT,
    created_by      TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_medications_person_status ON medications(person_id, status);
CREATE INDEX idx_medications_metadata_gin ON medications USING gin(metadata);


-- ============================================================================
-- 4 · SUPPLEMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS supplements (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id       UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    supplement_name TEXT NOT NULL,
    dose            TEXT,
    frequency       TEXT,
    timing          TEXT,
    status          TEXT DEFAULT 'active' CHECK (status IN ('active','discontinued','paused','trial')),
    reason          TEXT,
    safety_status   TEXT CHECK (safety_status IN ('cleared','caution','contraindicated','unknown')),
    notes           TEXT,
    created_by      TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_supplements_person_status ON supplements(person_id, status);
CREATE INDEX idx_supplements_metadata_gin ON supplements USING gin(metadata);


-- ============================================================================
-- 5 · LAB_PANELS
-- ============================================================================

CREATE TABLE IF NOT EXISTS lab_panels (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id           UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    panel_date          DATE,
    lab_name            TEXT,
    source_document_id  UUID,
    summary             TEXT,
    clinician_reviewed  BOOLEAN DEFAULT FALSE,
    created_by          TEXT,
    metadata            JSONB DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lab_panels_person_date ON lab_panels(person_id, panel_date DESC);


-- ============================================================================
-- 6 · LAB_MARKERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS lab_markers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lab_panel_id    UUID NOT NULL REFERENCES lab_panels(id) ON DELETE CASCADE,
    person_id       UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    marker_name     TEXT NOT NULL,
    value_text      TEXT,
    value_numeric   NUMERIC,
    unit            TEXT,
    reference_range TEXT,
    flag            TEXT CHECK (flag IN ('low','normal','high','critical','out_of_range', NULL)),
    interpretation  TEXT,
    created_by      TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lab_markers_person_marker ON lab_markers(person_id, marker_name);
CREATE INDEX idx_lab_markers_panel ON lab_markers(lab_panel_id);


-- ============================================================================
-- 7 · SYMPTOMS_LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS symptoms_log (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id     UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    symptom_name  TEXT NOT NULL,
    severity      INT CHECK (severity BETWEEN 1 AND 10),
    started_at    TIMESTAMPTZ,
    ended_at      TIMESTAMPTZ,
    context       TEXT,
    action_taken  TEXT,
    created_by    TEXT,
    metadata      JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_symptoms_person_created ON symptoms_log(person_id, created_at DESC);


-- ============================================================================
-- 8 · DECISIONS_LOG · IMMUTABLE APPEND-ONLY
-- ============================================================================

CREATE TABLE IF NOT EXISTS decisions_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id       UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    decision_title  TEXT NOT NULL,
    decision_body   TEXT NOT NULL,
    evidence_tier   TEXT CHECK (evidence_tier IN ('STRONG','MODERATE','EXPERIMENTAL','NOT_RECOMMENDED','N/A')),
    risk_level      TEXT,
    made_by         TEXT,
    revisit_date    DATE,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_decisions_person_created ON decisions_log(person_id, created_at DESC);

-- Prevent UPDATE/DELETE on decisions_log
CREATE OR REPLACE FUNCTION prevent_decisions_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'decisions_log is immutable · append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER decisions_log_no_update
    BEFORE UPDATE ON decisions_log
    FOR EACH ROW EXECUTE FUNCTION prevent_decisions_mutation();

CREATE TRIGGER decisions_log_no_delete
    BEFORE DELETE ON decisions_log
    FOR EACH ROW EXECUTE FUNCTION prevent_decisions_mutation();


-- ============================================================================
-- 9 · MEMORY_EVENTS · session deltas
-- ============================================================================

CREATE TABLE IF NOT EXISTS memory_events (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id    UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    source       TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    event_title  TEXT,
    event_body   TEXT,
    raw_delta    JSONB DEFAULT '{}'::jsonb,
    importance   INT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    session_id   TEXT,
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_memory_events_person_created ON memory_events(person_id, created_at DESC);
CREATE INDEX idx_memory_events_session ON memory_events(session_id);
CREATE INDEX idx_memory_events_raw_gin ON memory_events USING gin(raw_delta);


-- ============================================================================
-- 10 · RED_LINES · per-person safety rules
-- ============================================================================

CREATE TABLE IF NOT EXISTS red_lines (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id   UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    rule_code   TEXT NOT NULL,
    rule_title  TEXT NOT NULL,
    rule_body   TEXT NOT NULL,
    severity    TEXT DEFAULT 'hard_ban' CHECK (severity IN ('hard_ban','strong_caution','monitor','informational')),
    status      TEXT DEFAULT 'active' CHECK (status IN ('active','retired')),
    metadata    JSONB DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),
    UNIQUE (person_id, rule_code, status)
);

CREATE INDEX idx_red_lines_person_status ON red_lines(person_id, status);


-- ============================================================================
-- 11 · DOCUMENTS · uploaded files metadata
-- ============================================================================

CREATE TABLE IF NOT EXISTS documents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id       UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    document_type   TEXT,
    title           TEXT,
    file_path       TEXT,
    file_hash       TEXT,
    extracted_text  TEXT,
    summary         TEXT,
    created_by      TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_documents_person_type ON documents(person_id, document_type);
CREATE INDEX idx_documents_hash ON documents(file_hash);
CREATE INDEX idx_documents_text_search ON documents USING gin(to_tsvector('english', coalesce(extracted_text,'')));


-- ============================================================================
-- 12 · GENERATED_EXPORTS · MD file tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS generated_exports (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id     UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    export_type   TEXT NOT NULL CHECK (export_type IN ('state','labs_summary','protocol','decisions')),
    file_path     TEXT NOT NULL,
    content_hash  TEXT,
    generated_at  TIMESTAMPTZ DEFAULT now(),
    metadata      JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_exports_person_type ON generated_exports(person_id, export_type);


-- ============================================================================
-- 13 · API_AUDIT_LOG · every API call traced
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_audit_log (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id    TEXT,
    person_slug   TEXT,
    endpoint      TEXT NOT NULL,
    method        TEXT NOT NULL,
    status_code   INT,
    ip_address    INET,
    user_agent    TEXT,
    duration_ms   INT,
    error_message TEXT,
    metadata      JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_person_created ON api_audit_log(person_slug, created_at DESC);
CREATE INDEX idx_audit_endpoint ON api_audit_log(endpoint);
CREATE INDEX idx_audit_request ON api_audit_log(request_id);


-- ============================================================================
-- (Optional) 14 · EMBEDDINGS · pgvector
-- ============================================================================
-- Uncomment when pgvector is enabled in Coolify PG image.
--
-- CREATE TABLE IF NOT EXISTS embeddings (
--     id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
--     person_id    UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
--     source_type  TEXT,
--     source_id    UUID,
--     content      TEXT NOT NULL,
--     embedding    vector(1536),
--     metadata     JSONB DEFAULT '{}'::jsonb,
--     created_at   TIMESTAMPTZ DEFAULT now()
-- );
-- CREATE INDEX idx_embeddings_person ON embeddings(person_id);
-- CREATE INDEX idx_embeddings_vec ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);


-- ============================================================================
-- 15 · ROW-LEVEL SECURITY (RLS)
-- ============================================================================
-- Defense layer 2 · catches application-layer bugs.
-- API sets `app.person_id` per request · RLS enforces row visibility.

ALTER TABLE medical_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE medications        ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplements        ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_panels         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_markers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE symptoms_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE red_lines          ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_exports  ENABLE ROW LEVEL SECURITY;
-- persons table: API checks at app layer · admin role bypasses

CREATE POLICY person_isolation_conditions ON medical_conditions
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_medications ON medications
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_supplements ON supplements
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_lab_panels ON lab_panels
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_lab_markers ON lab_markers
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_symptoms ON symptoms_log
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_decisions ON decisions_log
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_memory ON memory_events
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_red_lines ON red_lines
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_documents ON documents
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));
CREATE POLICY person_isolation_exports ON generated_exports
    USING (person_id::TEXT = current_setting('app.person_id', TRUE));


-- ============================================================================
-- 16 · UPDATED_AT TRIGGER (auto-touch on row update)
-- ============================================================================

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER touch_persons         BEFORE UPDATE ON persons         FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_conditions      BEFORE UPDATE ON medical_conditions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_medications     BEFORE UPDATE ON medications     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_supplements     BEFORE UPDATE ON supplements     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_red_lines       BEFORE UPDATE ON red_lines       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ============================================================================
-- 17 · SEED · 3 PROFILES
-- ============================================================================

INSERT INTO persons (slug, display_label, relation_label, privacy_level, status, consent_recorded)
VALUES
    ('tareq',         'Tareq',      'self',   'private', 'active', TRUE),
    ('mashael-naser', 'Mashael',    'spouse', 'private', 'active', FALSE),
    ('abo-talal',     'Abo Talal',  'father', 'private', 'active', FALSE)
ON CONFLICT (slug) DO NOTHING;


-- ============================================================================
-- 18 · SEED · TAREQ RED LINES (R1-R5)
-- ============================================================================

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT id,
       'R1',
       'HARD BAN ON ASHWAGANDHA',
       'Never suggest, approve, or imply use of Ashwagandha (Withania somnifera) in any form. Contraindicated with hypothyroidism on Levothyroxine. Risk: hyperthyroidism, TSH suppression, thyroid storm. Adaptogen blends containing ashwagandha also banned.',
       'hard_ban'
FROM persons WHERE slug = 'tareq'
ON CONFLICT (person_id, rule_code, status) DO NOTHING;

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT id,
       'R2',
       'HARD BAN ON HIGH-DOSE PDE5 INHIBITORS',
       'Tadalafil/Sildenafil above 5mg daily restorative dose is forbidden. Defend 5mg ceiling unconditionally. Combined with Wellbutrin 300mg: severe tachycardia, BP spikes, migraine cascade, lowered seizure threshold. Refuse "just once 20mg" requests. Refuse stacking with additional vasodilators (high-dose L-citrulline, beetroot extract, agmatine). Nitrates of any kind: absolutely forbidden.',
       'hard_ban'
FROM persons WHERE slug = 'tareq'
ON CONFLICT (person_id, rule_code, status) DO NOTHING;

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT id,
       'R3',
       'THYROID ABSORPTION RULE (4-6 HOUR SEPARATION)',
       'Strict 4-6 hour minimum gap between Levothyroxine and: calcium, iron, magnesium >200mg, dairy, soy isoflavones, high-fiber meals >15g, calcium-fortified plant milks. Coffee: wait 45-60min minimum after Levothyroxine. Levo is fasted waking with water only. Any new supplement must be timing-assessed against Levo.',
       'hard_ban'
FROM persons WHERE slug = 'tareq'
ON CONFLICT (person_id, rule_code, status) DO NOTHING;

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT id,
       'R4',
       'NO STIMULANT OVERLOAD ON WELLBUTRIN',
       'Hard ban with Wellbutrin 300mg: L-Tyrosine (any dose), Mucuna Pruriens/L-Dopa, Yohimbine, DMHA, high-dose caffeine pre-workout stacks, prescription stimulants without psychiatrist clearance. Wellbutrin already loads dopamine/norepinephrine. Stacking lowers seizure threshold and risks cardiovascular events.',
       'hard_ban'
FROM persons WHERE slug = 'tareq'
ON CONFLICT (person_id, rule_code, status) DO NOTHING;

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT id,
       'R5',
       'NO DIAGNOSIS OR PRESCRIPTION REPLACEMENT',
       'AI is a coach, not a physician. Never diagnose. Never recommend prescription medication. Never recommend stopping/changing physician-prescribed Rx (dose, timing, brand) without physician sign-off. Escalate to physician for any clinical question outside coaching scope.',
       'hard_ban'
FROM persons WHERE slug = 'tareq'
ON CONFLICT (person_id, rule_code, status) DO NOTHING;


-- ============================================================================
-- 19 · SEED · BASELINE RED LINES (apply to all profiles · Mashael + Abo Talal)
-- ============================================================================

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT p.id, 'B1', 'NO DIAGNOSIS',
       'AI is a coach not a doctor. Never diagnose conditions. Refer to licensed physician for diagnosis.',
       'hard_ban'
FROM persons p WHERE p.slug IN ('mashael-naser', 'abo-talal')
ON CONFLICT (person_id, rule_code, status) DO NOTHING;

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT p.id, 'B2', 'NO NEW PRESCRIPTION RECOMMENDATIONS',
       'Never recommend new prescription medication. Only licensed physician can prescribe.',
       'hard_ban'
FROM persons p WHERE p.slug IN ('mashael-naser', 'abo-talal')
ON CONFLICT (person_id, rule_code, status) DO NOTHING;

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT p.id, 'B3', 'NO RX MODIFICATION WITHOUT PHYSICIAN',
       'Never modify physician-prescribed Rx (dose, timing, brand, route) without physician sign-off in the session.',
       'hard_ban'
FROM persons p WHERE p.slug IN ('mashael-naser', 'abo-talal')
ON CONFLICT (person_id, rule_code, status) DO NOTHING;

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT p.id, 'B4', 'SUPPLEMENT DOSE CAUTION',
       'No supplement recommendation above 100% RDA without explicit context (age, weight, existing meds, conditions). Default to lower end of safe range when uncertain.',
       'strong_caution'
FROM persons p WHERE p.slug IN ('mashael-naser', 'abo-talal')
ON CONFLICT (person_id, rule_code, status) DO NOTHING;

INSERT INTO red_lines (person_id, rule_code, rule_title, rule_body, severity)
SELECT p.id, 'B5', 'ER ESCALATION TRIGGERS',
       'Direct to ER immediately if: chest pain, severe shortness of breath, sudden severe headache, neurological symptoms (vision loss, weakness, slurred speech), suicidal ideation, severe allergic reaction, uncontrolled bleeding.',
       'hard_ban'
FROM persons p WHERE p.slug IN ('mashael-naser', 'abo-talal')
ON CONFLICT (person_id, rule_code, status) DO NOTHING;


-- ============================================================================
-- 20 · SEED · TAREQ MEDICATIONS
-- ============================================================================

INSERT INTO medications (person_id, medication_name, dose, frequency, timing, status, notes)
SELECT id, 'Levothyroxine', '50 mcg', 'daily', 'fasted waking · water only', 'active',
       'Wait 45-60 min before food/coffee. 4-6h gap from calcium/iron/magnesium per R3.'
FROM persons WHERE slug = 'tareq';

INSERT INTO medications (person_id, medication_name, dose, frequency, timing, status, notes)
SELECT id, 'Wellbutrin XL', '300 mg', 'daily', 'breakfast', 'active',
       'Bupropion extended-release. Monitor seizure threshold. Avoid stimulant stacking per R4.'
FROM persons WHERE slug = 'tareq';

INSERT INTO medications (person_id, medication_name, dose, frequency, timing, status, notes)
SELECT id, 'Tadalafil (Snafi)', '5 mg', 'daily', 'evening', 'active',
       'Daily restorative dose. LOCKED at 5mg per R2. No escalation without urologist sign-off.'
FROM persons WHERE slug = 'tareq';


-- ============================================================================
-- 21 · SEED · TAREQ SUPPLEMENTS
-- ============================================================================

INSERT INTO supplements (person_id, supplement_name, dose, frequency, timing, status, reason, safety_status)
SELECT id, 'Vitamin D3', '2000 IU', 'daily', 'breakfast with fat', 'active',
       'Mild D deficiency repletion (April 2026 panel)', 'cleared'
FROM persons WHERE slug = 'tareq';

INSERT INTO supplements (person_id, supplement_name, dose, frequency, timing, status, reason, safety_status)
SELECT id, 'Omega-3 (high-EPA TG form)', 'per label', 'daily', 'breakfast', 'active',
       'Inflammation · cognition · cardiovascular support', 'cleared'
FROM persons WHERE slug = 'tareq';

INSERT INTO supplements (person_id, supplement_name, dose, frequency, timing, status, reason, safety_status)
SELECT id, 'Iron Bisglycinate (Ferrochel)', '36 mg elemental', 'daily', 'afternoon with Vitamin C', 'active',
       'Active ferritin/iron repletion. 4-6h gap from Levothyroxine per R3.', 'cleared'
FROM persons WHERE slug = 'tareq';

INSERT INTO supplements (person_id, supplement_name, dose, frequency, timing, status, reason, safety_status)
SELECT id, 'Magnesium L-Threonate (Neuro-Mag)', '3 capsules', 'daily', 'bedtime', 'active',
       'Sleep + cognition. BBB-permeable form.', 'cleared'
FROM persons WHERE slug = 'tareq';

INSERT INTO supplements (person_id, supplement_name, dose, frequency, timing, status, reason, safety_status)
SELECT id, 'Vitamin C', '500 mg or orange juice', 'daily', 'with iron afternoon', 'active',
       'Boosts non-heme iron absorption', 'cleared'
FROM persons WHERE slug = 'tareq';


-- ============================================================================
-- 22 · SEED · TAREQ CONDITIONS
-- ============================================================================

INSERT INTO medical_conditions (person_id, condition_name, status, confidence_level, notes)
SELECT id, 'ADHD', 'managed', 'confirmed',
       'Executive dysfunction · focus issues · task paralysis. Managed on Wellbutrin 300mg.'
FROM persons WHERE slug = 'tareq';

INSERT INTO medical_conditions (person_id, condition_name, status, confidence_level, notes)
SELECT id, 'Hypothyroidism', 'managed', 'confirmed',
       'Euthyroid on Levothyroxine 50mcg. TSH calibrated. Monitor with each thyroid panel.'
FROM persons WHERE slug = 'tareq';

INSERT INTO medical_conditions (person_id, condition_name, status, confidence_level, notes)
SELECT id, 'Iron Deficiency', 'repleting', 'confirmed',
       'April 2026 panel. Target ferritin >70 ng/mL.'
FROM persons WHERE slug = 'tareq';

INSERT INTO medical_conditions (person_id, condition_name, status, confidence_level, notes)
SELECT id, 'Vitamin D Deficiency (mild)', 'repleting', 'confirmed',
       'April 2026 panel. On 2000 IU D3 daily.'
FROM persons WHERE slug = 'tareq';

INSERT INTO medical_conditions (person_id, condition_name, status, confidence_level, notes)
SELECT id, 'Pre-diabetes (borderline)', 'monitoring', 'confirmed',
       'HbA1c ~5.73% (April 2026). Target <5.4%.'
FROM persons WHERE slug = 'tareq';

INSERT INTO medical_conditions (person_id, condition_name, status, confidence_level, notes)
SELECT id, 'Chronic Fatigue / Dopamine Depletion (recovering)', 'active_recovery', 'self_reported',
       'Active nutrient repletion + cognitive recovery phase.'
FROM persons WHERE slug = 'tareq';


-- ============================================================================
-- 23 · INITIAL DECISION_LOG · system baseline
-- ============================================================================

INSERT INTO decisions_log (person_id, decision_title, decision_body, evidence_tier, made_by)
SELECT id, 'System Baseline · V02 Deployed',
       'T-OS Health Brain V02 architecture deployed. PostgreSQL HMDB active. 7 skill files loaded. Multi-LLM committee operational. 3 person profiles seeded (tareq, mashael-naser, abo-talal). Tareq red lines R1-R5 active. Baseline B1-B5 active for all profiles.',
       'N/A',
       'system_init'
FROM persons WHERE slug = 'tareq';


-- ============================================================================
-- END OF SCHEMA · V01
-- ============================================================================
-- Verification queries (run after migration):
--   SELECT count(*) FROM persons;           -- expect 3
--   SELECT count(*) FROM red_lines;         -- expect 5 + 5 + 5 = 15
--   SELECT count(*) FROM medications WHERE person_id = (SELECT id FROM persons WHERE slug='tareq');  -- expect 3
--   SELECT count(*) FROM supplements WHERE person_id = (SELECT id FROM persons WHERE slug='tareq');  -- expect 5
-- ============================================================================
