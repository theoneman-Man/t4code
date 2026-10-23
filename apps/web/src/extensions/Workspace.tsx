import { useRef, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { MessageSquare, ChevronDown, Check } from "lucide-react";
import { Menu as WorkspaceMenu } from "@base-ui/react/menu";
import { hostSidebarBrand } from "./HostBrand";
import { T3Wordmark } from "../components/T3Wordmark";
import "./Workspace.css";
import { extensionSlots, type RegisteredSlot } from "./registry";
import { openWorkspace, extensionHashKey } from "./navigation";
import { SlotHost } from "./SlotHost";
import { useHostExtContext } from "./hostContext";
import type { ExtContext } from "@t3tools/extension-sdk";

function WorkspaceBrand({ title }: { title: string }) {
  return (
    <>
      {hostSidebarBrand(<T3Wordmark aria-label="T3 Code" className="h-[1cap] w-auto shrink-0" />)}
      <span data-host-workspace="label">{title}</span>
      <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-55" />
    </>
  );
}

export function WorkspaceSwitcher({
  entries = extensionSlots,
}: {
  entries?: readonly RegisteredSlot[];
}) {
  const hash = useLocation({ select: (location) => location.hash });
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const slots = entries.filter((entry) => entry.slot.kind === "workspace");
  if (!slots.length) return null;
  const selected = slots.find((entry) => entry.key === extensionHashKey(hash, "workspace"));
  const title = selected?.slot.title ?? "Chat";
  return (
    <WorkspaceMenu.Root open={open} onOpenChange={setOpen}>
      <WorkspaceMenu.Trigger
        ref={triggerRef}
        data-host-workspace="trigger"
        aria-label="Switch workspace"
        aria-expanded={open}
        aria-description={`Current workspace: ${title}`}
      >
        <WorkspaceBrand title={title} />
      </WorkspaceMenu.Trigger>
      <WorkspaceMenu.Portal>
        <WorkspaceMenu.Positioner align="start" sideOffset={-28} data-host-workspace="positioner">
          <WorkspaceMenu.Popup
            data-host-workspace="popup"
            aria-label="Workspaces"
            finalFocus={triggerRef}
          >
            <WorkspaceMenu.Item
              aria-label="Close workspace switcher"
              // The opening pointer release lands on this overlaid row.
              onMouseUp={(event) => event.preventBaseUIHandler()}
              onClick={() => setOpen(false)}
            >
              <span data-host-workspace="header">
                <WorkspaceBrand title={title} />
              </span>
            </WorkspaceMenu.Item>
            <WorkspaceMenu.RadioGroup
              value={selected?.key ?? "chat"}
              onValueChange={(key) => openWorkspace(key)}
            >
              <WorkspaceMenu.RadioItem value="chat" closeOnClick>
                <span data-host-workspace="option">
                  <MessageSquare aria-hidden="true" />
                  Chat
                </span>
                <WorkspaceMenu.RadioItemIndicator>
                  <Check aria-hidden="true" />
                </WorkspaceMenu.RadioItemIndicator>
              </WorkspaceMenu.RadioItem>
              {slots.map(({ key, slot }) =>
                slot.kind === "workspace" ? (
                  <WorkspaceMenu.RadioItem key={key} value={key} closeOnClick>
                    <span data-host-workspace="option">
                      <slot.icon />
                      {slot.title}
                    </span>
                    <WorkspaceMenu.RadioItemIndicator>
                      <Check aria-hidden="true" />
                    </WorkspaceMenu.RadioItemIndicator>
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

export function withWorkspaceSwitcher(
  header: ReactNode,
  brand = false,
  entries: readonly RegisteredSlot[] = extensionSlots,
) {
  // The outer header hook stays a passthrough; only the brand position is replaced.
  if (!brand || !entries.some((entry) => entry.slot.kind === "workspace")) return header;
  return <WorkspaceSwitcher entries={entries} />;
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
