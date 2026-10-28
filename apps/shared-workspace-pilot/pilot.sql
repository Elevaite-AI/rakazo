-- Isolated pilot extension; does not modify the upstream schema or production.
CREATE SCHEMA IF NOT EXISTS shared_pilot;
CREATE TABLE IF NOT EXISTS shared_pilot.resources (
  space_id text PRIMARY KEY REFERENCES spaces(id),
  bot_id text UNIQUE NOT NULL REFERENCES bots(id),
  shared boolean NOT NULL DEFAULT false,
  executor_id text NOT NULL,
  credential_binding text NOT NULL CHECK (credential_binding='offline-test-agent')
);
CREATE TABLE IF NOT EXISTS shared_pilot.jobs (
  id text PRIMARY KEY,
  space_id text NOT NULL REFERENCES spaces(id),
  bot_id text NOT NULL REFERENCES bots(id),
  requester_id text NOT NULL,
  membership_id text NOT NULL,
  executor_id text NOT NULL,
  text text NOT NULL,
  nonce text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','completed','cancelled')),
  UNIQUE(space_id,requester_id,nonce)
);
CREATE TABLE IF NOT EXISTS shared_pilot.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  space_id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='shared_pilot_app') THEN
    CREATE ROLE shared_pilot_app LOGIN PASSWORD 'pilot-runtime-only' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public,shared_pilot TO shared_pilot_app;
GRANT SELECT ON spaces,space_members,bots,threads,messages,memory_documents,secrets TO shared_pilot_app;
GRANT DELETE,INSERT ON space_members TO shared_pilot_app;
GRANT INSERT ON messages TO shared_pilot_app;
GRANT UPDATE("nextMessageSeq") ON threads TO shared_pilot_app;
GRANT SELECT ON shared_pilot.resources TO shared_pilot_app;
GRANT SELECT,INSERT,UPDATE ON shared_pilot.jobs TO shared_pilot_app;
GRANT SELECT,INSERT ON shared_pilot.audit TO shared_pilot_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA shared_pilot TO shared_pilot_app;
-- SELECT FOR SHARE requires UPDATE privilege; no update API is exposed.
GRANT UPDATE ON space_members TO shared_pilot_app;
ALTER TABLE shared_pilot.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_pilot.audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pilot_job_scope ON shared_pilot.jobs;
CREATE POLICY pilot_job_scope ON shared_pilot.jobs USING (space_id=current_setting('app.space_id',true)) WITH CHECK (space_id=current_setting('app.space_id',true));
DROP POLICY IF EXISTS pilot_audit_scope ON shared_pilot.audit;
CREATE POLICY pilot_audit_scope ON shared_pilot.audit USING (space_id=current_setting('app.space_id',true)) WITH CHECK (space_id=current_setting('app.space_id',true));
