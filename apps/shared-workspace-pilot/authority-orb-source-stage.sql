-- Minimal reproduction of the inspected ORB permission source, for the isolated rehearsal.
-- Real ORB already owns these tables. Do not run these CREATE TABLE statements there.
CREATE TABLE public.team_member (id uuid PRIMARY KEY,user_id uuid UNIQUE NOT NULL,is_active boolean NOT NULL,employment_status text,ended_at timestamptz);
CREATE TABLE public.agent_access (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),team_member_id uuid NOT NULL REFERENCES public.team_member(id),agent_type text NOT NULL,agent_id uuid NOT NULL,has_access boolean NOT NULL,UNIQUE(team_member_id,agent_type));
CREATE TABLE permission_authority.resource_bindings(orb_agent_id uuid PRIMARY KEY,space_id text UNIQUE NOT NULL REFERENCES permission_authority.resources(space_id));
CREATE FUNCTION permission_authority.sync_member() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') THEN
   UPDATE permission_authority.members SET active=false WHERE profile_id=OLD.user_id;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
   INSERT INTO permission_authority.members(profile_id,active)
   VALUES(NEW.user_id,COALESCE(NEW.is_active AND NEW.employment_status='active' AND NEW.ended_at IS NULL,false))
   ON CONFLICT(profile_id) DO UPDATE SET active=excluded.active;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER team_authority_insert AFTER INSERT ON public.team_member FOR EACH ROW EXECUTE FUNCTION permission_authority.sync_member();
CREATE TRIGGER team_authority_update AFTER UPDATE OF user_id,is_active,employment_status,ended_at ON public.team_member FOR EACH ROW EXECUTE FUNCTION permission_authority.sync_member();
CREATE TRIGGER team_authority_delete AFTER DELETE ON public.team_member FOR EACH ROW EXECUTE FUNCTION permission_authority.sync_member();
CREATE FUNCTION permission_authority.sync_grant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') AND OLD.agent_type='rakazo-staging' THEN
   UPDATE permission_authority.grants g SET allowed=false
   FROM public.team_member m,permission_authority.resource_bindings r
   WHERE m.id=OLD.team_member_id AND r.orb_agent_id=OLD.agent_id AND g.canonical_id=m.user_id AND g.space_id=r.space_id;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') AND NEW.agent_type='rakazo-staging' THEN
   INSERT INTO permission_authority.grants(canonical_id,space_id,allowed)
   SELECT m.user_id,r.space_id,NEW.has_access FROM public.team_member m,permission_authority.resource_bindings r
   WHERE m.id=NEW.team_member_id AND r.orb_agent_id=NEW.agent_id
   ON CONFLICT(canonical_id,space_id) DO UPDATE SET allowed=excluded.allowed;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER access_authority_change AFTER INSERT OR UPDATE OR DELETE ON public.agent_access FOR EACH ROW EXECUTE FUNCTION permission_authority.sync_grant();
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA permission_authority FROM PUBLIC;
-- Grants for the decision function are explicit and survive the PUBLIC revoke.
