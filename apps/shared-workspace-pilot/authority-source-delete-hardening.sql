-- Match ORB's inspected source FK and revoke tombstoned grants even when the parent
-- is no longer visible to a cascading grant-delete trigger.
ALTER TABLE public.agent_access DROP CONSTRAINT agent_access_team_member_id_fkey;
ALTER TABLE public.agent_access ADD CONSTRAINT agent_access_team_member_id_fkey FOREIGN KEY(team_member_id) REFERENCES public.team_member(id) ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION permission_authority.sync_member() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') THEN
   UPDATE permission_authority.members SET active=false WHERE profile_id=OLD.user_id;
   IF TG_OP='DELETE' OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
     UPDATE permission_authority.grants SET allowed=false WHERE canonical_id=OLD.user_id;
   END IF;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
   INSERT INTO permission_authority.members(profile_id,active)
   VALUES(NEW.user_id,COALESCE(NEW.is_active AND NEW.employment_status='active' AND NEW.ended_at IS NULL,false))
   ON CONFLICT(profile_id) DO UPDATE SET active=excluded.active;
 END IF;
 RETURN NULL;
END $$;
