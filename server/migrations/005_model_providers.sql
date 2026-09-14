ALTER TABLE builds ADD COLUMN provider text NOT NULL DEFAULT 'openai'
  CHECK(provider IN ('openai','anthropic','deepseek','google','kimi','zai'));
ALTER TABLE build_worker_state ADD COLUMN providers jsonb NOT NULL DEFAULT '[]'
  CHECK(jsonb_typeof(providers)='array');
