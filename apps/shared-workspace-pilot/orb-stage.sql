-- Staging projection of inspected ORB tables, with explicit identity/resource bindings.
CREATE SCHEMA IF NOT EXISTS orb_stage;
REVOKE ALL ON SCHEMA orb_stage FROM PUBLIC;
CREATE TABLE IF NOT EXISTS orb_stage.profiles(id uuid PRIMARY KEY,email text NOT NULL);
CREATE TABLE IF NOT EXISTS orb_stage.team_member(id uuid PRIMARY KEY,user_id uuid UNIQUE REFERENCES orb_stage.profiles(id),is_active boolean NOT NULL,employment_status text NOT NULL,ended_at timestamptz);
CREATE TABLE IF NOT EXISTS orb_stage.agent_access(id uuid PRIMARY KEY,team_member_id uuid REFERENCES orb_stage.team_member(id),agent_id uuid NOT NULL,agent_type text NOT NULL DEFAULT 'rakazo',has_access boolean NOT NULL,UNIQUE(team_member_id,agent_id));
CREATE TABLE IF NOT EXISTS orb_stage.identity_aliases(alias_profile_id uuid PRIMARY KEY REFERENCES orb_stage.profiles(id),canonical_profile_id uuid NOT NULL REFERENCES orb_stage.profiles(id),CHECK(alias_profile_id<>canonical_profile_id));
CREATE TABLE IF NOT EXISTS orb_stage.rakazo_identities(rakazo_user_id text PRIMARY KEY,profile_id uuid NOT NULL REFERENCES orb_stage.profiles(id));
CREATE TABLE IF NOT EXISTS orb_stage.grant_versions(grant_id uuid PRIMARY KEY REFERENCES orb_stage.agent_access(id),version integer NOT NULL DEFAULT 1);
CREATE OR REPLACE FUNCTION orb_stage.bump_grant_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE orb_stage.grant_versions SET version=version+1 WHERE grant_id=NEW.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS access_version ON orb_stage.agent_access;
CREATE TRIGGER access_version AFTER UPDATE OF has_access ON orb_stage.agent_access FOR EACH ROW EXECUTE FUNCTION orb_stage.bump_grant_version();
GRANT USAGE ON SCHEMA orb_stage TO rakazo_app;
GRANT SELECT ON ALL TABLES IN SCHEMA orb_stage TO rakazo_app;
