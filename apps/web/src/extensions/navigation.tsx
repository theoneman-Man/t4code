import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { findExtensionSlot } from "./registry";
import type { ScopedThreadRef } from "@t3tools/contracts";

function activateExtensionPanel(threadRef: ScopedThreadRef, id: string) {
  void import("../rightPanelStore").then(({ useRightPanelStore }) =>
    useRightPanelStore.getState().openExtension(threadRef, id),
  );
}

const NAVIGATION_EVENT = "t4:extension-navigation";
export function openWorkspace(id: string) {
  window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT, { detail: { kind: "workspace", id } }));
}
export function openPanel(id: string) {
  window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT, { detail: { kind: "rightPanel", id } }));
}

// Hash routes preserve the current chat URL and its search. The router owns history updates,
// so reload and back/forward restore both the underlying thread and the selected workspace.
export const workspaceHash = (id: string) =>
  id === "chat" ? "" : `ext-workspace=${encodeURIComponent(id)}`;
export const settingsHash = (id: string) => `ext-settings=${encodeURIComponent(id)}`;
export function extensionHashKey(hash: string, kind: "workspace" | "settings") {
  const prefix = `ext-${kind}=`;
  if (!hash.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(hash.slice(prefix.length));
  } catch {
    return null;
  }
}

export function ExtensionNavigationBridge() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const threadRef = useThreadRouteRef();
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: "workspace" | "rightPanel"; id: string }>)
        .detail;
      if (
        detail.kind === "workspace" &&
        (detail.id === "chat" || findExtensionSlot(detail.id, "workspace"))
      ) {
        void navigate({
          to: pathname.startsWith("/settings") ? "/" : pathname,
          hash: workspaceHash(detail.id),
        });
      }
      if (detail.kind === "rightPanel" && threadRef && findExtensionSlot(detail.id, "rightPanel")) {
        activateExtensionPanel(threadRef, detail.id);
      }
    };
    window.addEventListener(NAVIGATION_EVENT, listener);
    return () => window.removeEventListener(NAVIGATION_EVENT, listener);
  }, [navigate, pathname, threadRef]);
  return null;
}
