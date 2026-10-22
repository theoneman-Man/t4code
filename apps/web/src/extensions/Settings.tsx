import { type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar";
import { extensionSlots, findExtensionSlot } from "./registry";
import { extensionHashKey, settingsHash } from "./navigation";
import { SlotHost } from "./SlotHost";
import { useHostExtContext } from "./hostContext";

export function hasExtensionSettingsSelection(hash: string) {
  const key = extensionHashKey(hash, "settings");
  return Boolean(key && findExtensionSlot(key, "settings"));
}

export function ExtensionSettingsHeader({ children }: { children: ReactNode }) {
  const hash = useLocation({ select: (location) => location.hash });
  const key = extensionHashKey(hash, "settings");
  const entry = key && findExtensionSlot(key, "settings");
  return entry ? <span className="text-sm font-medium">{entry.slot.title}</span> : children;
}

export function ExtensionSettingsNav() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  return extensionSlots.map(({ key, slot }) =>
    slot.kind === "settings" ? (
      <SidebarMenuItem key={key}>
        <SidebarMenuButton
          isActive={extensionHashKey(hash, "settings") === key}
          onClick={() => void navigate({ to: "/settings/general", hash: settingsHash(key) })}
        >
          {slot.title}
        </SidebarMenuButton>
      </SidebarMenuItem>
    ) : null,
  );
}

export function ExtensionSettingsOutlet({ children }: { children: ReactNode }) {
  const hash = useLocation({ select: (location) => location.hash });
  const context = useHostExtContext();
  const key = extensionHashKey(hash, "settings");
  const entry = key && findExtensionSlot(key, "settings");
  // Sharing the existing settings outlet keeps settings scope and authentication in one route.
  return entry && context ? (
    <SlotHost
      key={`${context.environmentId}:${entry.key}`}
      entry={entry}
      context={context}
      active
    />
  ) : (
    children
  );
}
