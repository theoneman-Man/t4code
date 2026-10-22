import { useState, type ReactNode } from "react";
import { MenuItem } from "../components/ui/menu";
import { Button } from "../components/ui/button";
import { extensionSlots, findExtensionSlot } from "./registry";
import { useHostExtContext } from "./hostContext";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import { SlotHost } from "./SlotHost";
import type { ExtContext } from "@t3tools/extension-sdk";

function available(key: string, context: ExtContext) {
  const entry = findExtensionSlot(key, "rightPanel");
  if (entry?.slot.kind !== "rightPanel") return false;
  try {
    return entry.slot.available?.(context) ?? true;
  } catch {
    return false;
  }
}

export function ExtensionPanelMenuItems() {
  const context = useHostExtContext();
  const ref = useThreadRouteRef();
  if (!context || !ref) return null;
  return extensionSlots.map(({ key, slot }) =>
    slot.kind === "rightPanel" && available(key, context) ? (
      <MenuItem key={key} onClick={() => useRightPanelStore.getState().openExtension(ref, key)}>
        <slot.icon />
        {slot.title}
      </MenuItem>
    ) : null,
  );
}

export function ExtensionPanelLauncherItems() {
  const context = useHostExtContext();
  const ref = useThreadRouteRef();
  if (!context || !ref) return null;
  const slots = extensionSlots.filter(
    (entry) => entry.slot.kind === "rightPanel" && available(entry.key, context),
  );
  if (!slots.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {slots.map(({ key, slot }) =>
        slot.kind === "rightPanel" ? (
          <Button
            key={key}
            variant="outline"
            onClick={() => useRightPanelStore.getState().openExtension(ref, key)}
          >
            <slot.icon />
            {slot.title}
          </Button>
        ) : null,
      )}
    </div>
  );
}

export function ExtensionPanelIcon({ slotKey }: { slotKey: string }) {
  const slot = findExtensionSlot(slotKey, "rightPanel")?.slot;
  return slot?.kind === "rightPanel" ? <slot.icon /> : null;
}

export function ExtensionPanels({
  surfaces,
  activeSurfaceId,
  open,
  environmentId,
  children,
}: {
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  open: boolean;
  environmentId: string | null;
  children: ReactNode;
}) {
  const hostContext = useHostExtContext();
  const context = hostContext && environmentId ? { ...hostContext, environmentId } : null;
  const [visited, setVisited] = useState<string[]>([]);
  const active = surfaces.find(
    (surface) => surface.id === activeSurfaceId && surface.kind === "extension",
  );
  const activeKey = active && environmentId ? `${environmentId}:${active.id}` : null;
  if (activeKey && !visited.includes(activeKey)) setVisited([...visited, activeKey]);
  if (!surfaces.some((surface) => surface.kind === "extension")) return children;
  return (
    <>
      {active ? null : children}
      {context
        ? surfaces.map((surface) => {
            if (surface.kind !== "extension") return null;
            const entry = findExtensionSlot(surface.slotKey, "rightPanel");
            if (!entry || entry.slot.kind !== "rightPanel") return null;
            const isActive = active?.id === surface.id;
            if (
              !isActive &&
              !(entry.slot.keepAlive && visited.includes(`${environmentId}:${surface.id}`))
            )
              return null;
            return (
              <div
                key={`${environmentId}:${surface.id}`}
                hidden={!isActive}
                className={isActive ? "flex min-h-0 flex-1 flex-col" : "hidden"}
              >
                {available(entry.key, context) ? (
                  <SlotHost entry={entry} context={context} active={isActive && open} />
                ) : (
                  <p className="p-4 text-sm text-muted-foreground">
                    This extension view is unavailable here.
                  </p>
                )}
              </div>
            );
          })
        : null}
    </>
  );
}
