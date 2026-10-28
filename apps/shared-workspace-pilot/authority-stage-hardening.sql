ALTER TABLE permission_authority.reader_scopes ADD COLUMN revision bigint NOT NULL DEFAULT nextval('permission_authority.revision_seq');
CREATE TRIGGER scopes_revision BEFORE INSERT OR UPDATE ON permission_authority.reader_scopes FOR EACH ROW EXECUTE FUNCTION permission_authority.bump_revision();
CREATE OR REPLACE FUNCTION permission_authority.resolve(subject text, requested_space text)
RETURNS TABLE(execution_user_id text,bot_id text,revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT r.execution_user_id,r.bot_id,
   concat_ws(':',i.epoch,p.revision,a.revision,m.revision,g.revision,r.revision,s.revision)
 FROM permission_authority.instance i CROSS JOIN permission_authority.principals p
 JOIN permission_authority.aliases a ON a.profile_id=p.profile_id
 JOIN permission_authority.members m ON m.profile_id=a.canonical_id
 JOIN permission_authority.grants g ON g.canonical_id=m.profile_id AND g.space_id=requested_space
 JOIN permission_authority.resources r ON r.space_id=g.space_id
 JOIN permission_authority.reader_scopes s ON s.space_id=r.space_id AND s.login_name=session_user
 WHERE p.subject_id=subject AND m.active AND g.allowed
$$;
CREATE FUNCTION permission_authority.immutable_resource_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Resource bindings are immutable; provision a new resource explicitly'; END $$;
CREATE TRIGGER binding_immutable BEFORE UPDATE OR DELETE ON permission_authority.resource_bindings FOR EACH ROW EXECUTE FUNCTION permission_authority.immutable_resource_binding();
REVOKE ALL ON FUNCTION permission_authority.immutable_resource_binding() FROM PUBLIC;
