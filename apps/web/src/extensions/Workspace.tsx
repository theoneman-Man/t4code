import { useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { MessageSquare, ChevronDown } from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../components/ui/menu";
import { Button } from "../components/ui/button";
import { extensionSlots, type RegisteredSlot } from "./registry";
import { openWorkspace, extensionHashKey } from "./navigation";
import { SlotHost } from "./SlotHost";
import { useHostExtContext } from "./hostContext";
import type { ExtContext } from "@t3tools/extension-sdk";

export function WorkspaceSwitcher({
  entries = extensionSlots,
}: {
  entries?: readonly RegisteredSlot[];
}) {
  const hash = useLocation({ select: (location) => location.hash });
  const slots = entries.filter((entry) => entry.slot.kind === "workspace");
  if (!slots.length) return null;
  const selected = slots.find((entry) => entry.key === extensionHashKey(hash, "workspace"));
  return (
    <div className="w-full px-2 pb-2 [-webkit-app-region:no-drag]">
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="sm" aria-label="Switch workspace" />}>
          {selected?.slot.title ?? "Chat"}
          <ChevronDown className="size-3" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem onClick={() => openWorkspace("chat")}>
            <MessageSquare />
            Chat
          </MenuItem>
          {slots.map(({ key, slot }) =>
            slot.kind === "workspace" ? (
              <MenuItem key={key} onClick={() => openWorkspace(key)}>
                <slot.icon />
                {slot.title}
              </MenuItem>
            ) : null,
          )}
        </MenuPopup>
      </Menu>
    </div>
  );
}

export function withWorkspaceSwitcher(header: ReactNode) {
  if (!extensionSlots.some((entry) => entry.slot.kind === "workspace")) return header;
  return (
    <>
      {header}
      <WorkspaceSwitcher />
    </>
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
