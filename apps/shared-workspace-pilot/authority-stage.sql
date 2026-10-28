-- Isolated ORB permission authority candidate. Never apply directly to production.
CREATE SCHEMA permission_authority;
REVOKE ALL ON SCHEMA permission_authority FROM PUBLIC;
CREATE SEQUENCE permission_authority.revision_seq;
CREATE TABLE permission_authority.instance (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), epoch uuid NOT NULL DEFAULT gen_random_uuid());
INSERT INTO permission_authority.instance(singleton) VALUES (true);
CREATE TABLE permission_authority.members (
 profile_id uuid PRIMARY KEY, active boolean NOT NULL, revision bigint NOT NULL DEFAULT nextval('permission_authority.revision_seq')
);
CREATE TABLE permission_authority.aliases (
 profile_id uuid PRIMARY KEY, canonical_id uuid NOT NULL REFERENCES permission_authority.members(profile_id),
 revision bigint NOT NULL DEFAULT nextval('permission_authority.revision_seq')
);
CREATE TABLE permission_authority.principals (
 subject_id text PRIMARY KEY, profile_id uuid NOT NULL REFERENCES permission_authority.aliases(profile_id),
 revision bigint NOT NULL DEFAULT nextval('permission_authority.revision_seq')
);
CREATE TABLE permission_authority.resources (
 space_id text PRIMARY KEY, execution_user_id text NOT NULL, bot_id text NOT NULL,
 revision bigint NOT NULL DEFAULT nextval('permission_authority.revision_seq')
);
CREATE TABLE permission_authority.grants (
 canonical_id uuid NOT NULL REFERENCES permission_authority.members(profile_id),
 space_id text NOT NULL REFERENCES permission_authority.resources(space_id), allowed boolean NOT NULL,
 revision bigint NOT NULL DEFAULT nextval('permission_authority.revision_seq'), PRIMARY KEY(canonical_id,space_id)
);
CREATE TABLE permission_authority.reader_scopes (
 login_name name NOT NULL, space_id text NOT NULL REFERENCES permission_authority.resources(space_id), PRIMARY KEY(login_name,space_id)
);
CREATE FUNCTION permission_authority.bump_revision() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN NEW.revision := nextval('permission_authority.revision_seq'); RETURN NEW; END $$;
CREATE TRIGGER members_revision BEFORE INSERT OR UPDATE ON permission_authority.members FOR EACH ROW EXECUTE FUNCTION permission_authority.bump_revision();
CREATE TRIGGER aliases_revision BEFORE INSERT OR UPDATE ON permission_authority.aliases FOR EACH ROW EXECUTE FUNCTION permission_authority.bump_revision();
CREATE TRIGGER principals_revision BEFORE INSERT OR UPDATE ON permission_authority.principals FOR EACH ROW EXECUTE FUNCTION permission_authority.bump_revision();
CREATE TRIGGER resources_revision BEFORE INSERT OR UPDATE ON permission_authority.resources FOR EACH ROW EXECUTE FUNCTION permission_authority.bump_revision();
CREATE TRIGGER grants_revision BEFORE INSERT OR UPDATE ON permission_authority.grants FOR EACH ROW EXECUTE FUNCTION permission_authority.bump_revision();
-- The app can ask only about an explicitly assigned space. No directory enumeration.
CREATE FUNCTION permission_authority.resolve(subject text, requested_space text)
RETURNS TABLE(execution_user_id text,bot_id text,revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT r.execution_user_id,r.bot_id,
   concat_ws(':',i.epoch,p.revision,a.revision,m.revision,g.revision,r.revision)
 FROM permission_authority.instance i CROSS JOIN permission_authority.principals p
 JOIN permission_authority.aliases a ON a.profile_id=p.profile_id
 JOIN permission_authority.members m ON m.profile_id=a.canonical_id
 JOIN permission_authority.grants g ON g.canonical_id=m.profile_id AND g.space_id=requested_space
 JOIN permission_authority.resources r ON r.space_id=g.space_id
 JOIN permission_authority.reader_scopes s ON s.space_id=r.space_id AND s.login_name=session_user
 WHERE p.subject_id=subject AND m.active AND g.allowed
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA permission_authority FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA permission_authority FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA permission_authority FROM PUBLIC;
