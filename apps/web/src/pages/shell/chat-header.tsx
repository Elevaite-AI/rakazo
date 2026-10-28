import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  GroupAvatar,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Menu, Monitor, MoreHorizontal, Phone } from "lucide-react";
import { useState } from "react";
import { IconTooltip } from "../../components/IconTooltip";
import { rpcForSpace } from "../../lib/rpc";
import { useConversationOnly } from "../../lib/workspace-capabilities";

type TeamAccessMember = { id: string; name: string; canApprove: boolean };

/** The floating header over the transcript: navigation, the chat's name, call and computer. */
export function ChatHeader({
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  phoneCallsEnabled,
  inCall,
  computerPanelOpen,
  onOpenNavigation,
  onOpenChatSettings,
  onCall,
  onToggleComputer,
}: {
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: ThreadSnapshot | null;
  phoneCallsEnabled: boolean;
  inCall: boolean;
  computerPanelOpen: boolean;
  onOpenNavigation: () => void;
  onOpenChatSettings: () => void;
  onCall: (bot: Bot) => void;
  onToggleComputer: (bot: Bot) => void;
}) {
  const { t } = useLingui();
  const conversationOnly = useConversationOnly();
  const [teamSettingsOpen, setTeamSettingsOpen] = useState(false);
  const access = useQuery<TeamAccessMember[]>({
    queryKey: ["shared-bot-access", active?.spaceId, active?.id],
    queryFn: async () =>
      active ? await rpcForSpace(active.spaceId).spaces.accessMembers({ botId: active.id }) : [],
    enabled: conversationOnly && Boolean(active),
    retry: false,
    refetchInterval: conversationOnly ? 30_000 : false,
    refetchOnWindowFocus: true,
  });
  const accessMembers = access.isError ? [] : (access.data ?? []);
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 px-3 py-[13px] md:px-[22px] [&_button]:pointer-events-auto">
        <div className="flex items-center">
          <Button
            variant="floating"
            size="icon-lg"
            aria-label={t`Open navigation`}
            onClick={onOpenNavigation}
            className="app-no-drag md:hidden"
          >
            <Menu strokeWidth={1.7} className="size-[19px]" />
          </Button>
        </div>
        {conversationOnly ? (
          <div className="flex min-w-0 items-center gap-2 px-3 py-1 text-sm font-medium">
            <span className="min-w-0 truncate">{active?.name}</span>
            {active && accessMembers.length ? (
              <button
                type="button"
                aria-label={t`View team access`}
                data-testid="team-access-members"
                className="flex shrink-0 items-center ps-1"
                onClick={() => {
                  setTeamSettingsOpen(true);
                  void access.refetch();
                }}
              >
                {accessMembers.slice(0, 3).map((member) => (
                  <span
                    key={member.id}
                    title={member.name}
                    aria-hidden="true"
                    className="-ms-1 flex size-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-foreground"
                  >
                    {member.name.trim().slice(0, 1).toLocaleUpperCase()}
                  </span>
                ))}
                {accessMembers.length > 3 ? (
                  <span className="ms-0.5 text-xs text-muted-foreground">
                    +{accessMembers.length - 3}
                  </span>
                ) : null}
              </button>
            ) : null}
          </div>
        ) : (
          <Button
            variant="floating"
            data-testid="bot-settings-trigger"
            onClick={onOpenChatSettings}
            className="app-no-drag h-auto min-w-0 gap-2 py-1 ps-1 pe-3.5"
          >
            {inGroup ? (
              <GroupAvatar
                members={activeSnapshot?.members ?? activeGroup?.members ?? []}
                size={26}
              />
            ) : active ? (
              <BotAvatar
                color={active.color}
                identity={active.id}
                size={26}
                status={active.status}
              />
            ) : null}
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-medium text-foreground" dir="auto">
                {inGroup
                  ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                  : (active?.name ?? t`Select a bot`)}
              </span>
            </span>
          </Button>
        )}
        <div className="flex items-center justify-self-end gap-2">
          {conversationOnly && active ? (
            <IconTooltip label={t`Team bot settings`}>
              <Button
                variant="floating"
                size="icon-lg"
                aria-label={t`Team bot settings`}
                data-testid="team-bot-settings-trigger"
                onClick={() => {
                  setTeamSettingsOpen(true);
                  void access.refetch();
                }}
                className="app-no-drag"
              >
                <MoreHorizontal strokeWidth={1.7} className="size-[19px]" />
              </Button>
            </IconTooltip>
          ) : null}
          {phoneCallsEnabled && !inGroup && active ? (
            <IconTooltip label={inCall ? t`Open call` : t`Call`}>
              <Button
                variant="floating"
                size="icon-lg"
                data-testid="call-button"
                aria-label={inCall ? t`Open call` : t`Call`}
                onClick={() => onCall(active)}
                data-active={inCall ? "" : undefined}
                className="app-no-drag"
              >
                <Phone strokeWidth={1.6} className="size-[17px]" />
              </Button>
            </IconTooltip>
          ) : null}
          {!conversationOnly && !inGroup && active ? (
            <IconTooltip label={t`Agent computer`}>
              <Button
                variant="floating"
                size="icon-lg"
                aria-label={t`Agent computer`}
                aria-pressed={computerPanelOpen}
                onClick={() => onToggleComputer(active)}
                className="app-no-drag"
              >
                <Monitor strokeWidth={1.6} className="size-[18px]" />
              </Button>
            </IconTooltip>
          ) : null}
        </div>
      </div>
      <Dialog
        open={teamSettingsOpen && conversationOnly && Boolean(active)}
        onOpenChange={setTeamSettingsOpen}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
          data-testid="team-bot-settings"
        >
          <DialogHeader>
            <DialogTitle>{t`Team bot settings`}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">{t`Bot`}</p>
              <p className="font-medium">{active?.name}</p>
            </div>
            {active?.description ? (
              <div>
                <p className="text-xs text-muted-foreground">{t`Description`}</p>
                <p className="whitespace-pre-wrap">{active.description}</p>
              </div>
            ) : null}
            <div>
              <p className="text-xs text-muted-foreground">{t`Accounts with access`}</p>
              {access.isError ? (
                <p role="status">{t`Access unavailable`}</p>
              ) : access.isPending ? (
                <p role="status">{t`Loading`}</p>
              ) : (
                <ul className="mt-2 space-y-2" data-testid="team-access-list">
                  {accessMembers.map((member) => (
                    <li key={member.id} className="flex items-center justify-between gap-3">
                      <span>{member.name}</span>
                      {member.canApprove ? (
                        <span className="text-xs text-muted-foreground">{t`Approver`}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t`Team bot editing is not available yet.`}</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
