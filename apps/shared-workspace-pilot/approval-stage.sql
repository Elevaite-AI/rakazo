-- Candidate for the isolated exact-release database only; not a live migration.
CREATE TABLE permission_authority.approvers (
 canonical_id uuid NOT NULL,
 space_id text NOT NULL REFERENCES permission_authority.resources(space_id),
 allowed boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT nextval('permission_authority.revision_seq'),
 PRIMARY KEY(canonical_id,space_id)
);
ALTER TABLE permission_authority.approvers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON permission_authority.approvers FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER approver_revision BEFORE INSERT OR UPDATE ON permission_authority.approvers
 FOR EACH ROW EXECUTE FUNCTION permission_authority.bump_revision();
CREATE FUNCTION permission_authority.resolve_with_approval(subject text,requested_space text)
RETURNS TABLE(execution_user_id text,bot_id text,revision text,approval_revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT decision.*, CASE WHEN ap.allowed THEN concat_ws(':',i.epoch,ap.revision) END
 FROM permission_authority.resolve(subject,requested_space) decision
 JOIN permission_authority.principals p ON p.subject_id=subject
 JOIN permission_authority.aliases a ON a.profile_id=p.profile_id
 CROSS JOIN permission_authority.instance i
 LEFT JOIN permission_authority.approvers ap ON ap.canonical_id=a.canonical_id AND ap.space_id=requested_space
$$;
REVOKE ALL ON FUNCTION permission_authority.resolve_with_approval(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION permission_authority.resolve_with_approval(text,text) TO rakazo_permission_reader;
