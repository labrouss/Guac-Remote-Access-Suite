-- Singleton system_config row; gates the first-time setup wizard
CREATE TABLE system_config (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    setup_completed BOOLEAN NOT NULL DEFAULT false,
    setup_completed_at TIMESTAMPTZ,
    instance_name TEXT,
    vault_addr TEXT,
    default_theme_id UUID REFERENCES themes(id)
);

INSERT INTO system_config (id) VALUES (true);
