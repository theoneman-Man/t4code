import { useRef, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { Menu as WorkspaceMenu } from "@base-ui/react/menu";
import { ChatIcon } from "./WorkspaceIcons";
import "./Workspace.css";
import { extensionSlots, type RegisteredSlot } from "./registry";
import { openWorkspace, extensionHashKey } from "./navigation";
import { SlotHost } from "./SlotHost";
import { useHostExtContext } from "./hostContext";
import type { ExtContext } from "@t3tools/extension-sdk";

export function WorkspaceSwitcher({
  entries = extensionSlots,
  onBackdrop = false,
}: {
  entries?: readonly RegisteredSlot[];
  onBackdrop?: boolean;
}) {
  const hash = useLocation({ select: (location) => location.hash });
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const slots = entries.filter((entry) => entry.slot.kind === "workspace");
  if (!slots.length) return null;
  const selected = slots.find((entry) => entry.key === extensionHashKey(hash, "workspace"));
  const title = selected?.slot.title ?? "Chat";
  const Icon = selected?.slot.kind === "workspace" ? selected.slot.icon : ChatIcon;
  return (
    <WorkspaceMenu.Root open={open} onOpenChange={setOpen} orientation="horizontal">
      <WorkspaceMenu.Trigger
        ref={triggerRef}
        data-host-workspace="trigger"
        data-backdrop={onBackdrop || undefined}
        aria-label="Switch workspace"
        aria-expanded={open}
        aria-description={`Current workspace: ${title}`}
      >
        <Icon />
      </WorkspaceMenu.Trigger>
      <WorkspaceMenu.Portal>
        <WorkspaceMenu.Positioner
          side="inline-end"
          align="center"
          sideOffset={6}
          data-host-workspace="positioner"
        >
          <WorkspaceMenu.Popup
            data-host-workspace="popup"
            aria-label="Workspaces"
            finalFocus={triggerRef}
          >
            <WorkspaceMenu.RadioGroup value={selected?.key ?? "chat"} onValueChange={openWorkspace}>
              <WorkspaceMenu.RadioItem value="chat" aria-label="Chat" title="Chat" closeOnClick>
                <ChatIcon />
              </WorkspaceMenu.RadioItem>
              {slots.map(({ key, slot }) =>
                slot.kind === "workspace" ? (
                  <WorkspaceMenu.RadioItem
                    key={key}
                    value={key}
                    aria-label={slot.title}
                    title={slot.title}
                    closeOnClick
                  >
                    <slot.icon />
                  </WorkspaceMenu.RadioItem>
                ) : null,
              )}
            </WorkspaceMenu.RadioGroup>
          </WorkspaceMenu.Popup>
        </WorkspaceMenu.Positioner>
      </WorkspaceMenu.Portal>
    </WorkspaceMenu.Root>
  );
}

export function WorkspaceViews({
  children,
  context,
  selected,
  entries = extensionSlots,
  renderSlot,
}: {
  children: ReactNode;
  context: ExtContext;
  selected: string | null;
  entries?: readonly RegisteredSlot[];
  renderSlot?: (entry: RegisteredSlot, active: boolean) => ReactNode;
}) {
  const slots = entries.filter((entry) => entry.slot.kind === "workspace");
  const active = slots.find((entry) => entry.key === selected);
  const [visited, setVisited] = useState<string[]>([]);
  const activeKey = active ? `${context.environmentId}:${active.key}` : null;
  if (activeKey && !visited.includes(activeKey)) setVisited([...visited, activeKey]);
  if (!slots.length) return children;
  return (
    <>
      <div hidden={Boolean(active)} className={active ? "hidden" : "contents"}>
        {children}
      </div>
      {slots.map((entry) => {
        const isActive = entry === active;
        if (
          !isActive &&
          !(
            entry.slot.kind === "workspace" &&
            entry.slot.keepAlive &&
            visited.includes(`${context.environmentId}:${entry.key}`)
          )
        )
          return null;
        return (
          <main
            key={`${context.environmentId}:${entry.key}`}
            hidden={!isActive}
            className={isActive ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}
          >
            {renderSlot ? (
              renderSlot(entry, isActive)
            ) : (
              <SlotHost entry={entry} context={context} active={isActive} />
            )}
          </main>
        );
      })}
    </>
  );
}

export function ExtensionWorkspaceOutlet({ children }: { children: ReactNode }) {
  const context = useHostExtContext();
  const hash = useLocation({ select: (location) => location.hash });
  return context ? (
    <WorkspaceViews context={context} selected={extensionHashKey(hash, "workspace")}>
      {children}
    </WorkspaceViews>
  ) : (
    children
  );
}
