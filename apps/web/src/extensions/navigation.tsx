import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { extensionSlots, findExtensionSlot, type RegisteredSlot } from "./registry";
import type { ScopedThreadRef } from "@t3tools/contracts";

function activateExtensionPanel(threadRef: ScopedThreadRef, id: string) {
  void import("../rightPanelStore").then(({ useRightPanelStore }) =>
    useRightPanelStore.getState().openExtension(threadRef, id),
  );
}

const NAVIGATION_EVENT = "t4:extension-navigation";
const initialLocationAllowsDefault = window.location.pathname === "/" && !window.location.hash;
let defaultLandingConsumed = false;
export function openWorkspace(id: string) {
  window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT, { detail: { kind: "workspace", id } }));
}
export function openPanel(id: string) {
  window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT, { detail: { kind: "rightPanel", id } }));
}
export function openExtensionThread(environmentId: string, threadId: string) {
  window.dispatchEvent(
    new CustomEvent(NAVIGATION_EVENT, {
      detail: { kind: "thread", id: threadId, environmentId },
    }),
  );
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

export function ExtensionNavigationBridge({
  entries = extensionSlots,
}: {
  entries?: readonly RegisteredSlot[];
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hash = useLocation({ select: (location) => location.hash });
  const initialWorkspace = useRef(pathname === "/" ? extensionHashKey(hash, "workspace") : null);
  const threadRef = useThreadRouteRef();
  const defaultWorkspace = useRef(
    pathname === "/" &&
      !hash &&
      (entries !== extensionSlots || (initialLocationAllowsDefault && !defaultLandingConsumed))
      ? entries.find((entry) => entry.slot.kind === "workspace" && entry.slot.default)?.key
      : undefined,
  );
  useEffect(() => {
    if (pathname === "/") return;
    const workspace = initialWorkspace.current;
    initialWorkspace.current = null;
    // The index starts a draft asynchronously and its replace navigation omits the hash.
    if (workspace && pathname.startsWith("/draft/") && !hash) {
      void navigate({ to: pathname, hash: workspaceHash(workspace), search: true, replace: true });
    }
  }, [hash, navigate, pathname]);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          kind: "workspace" | "rightPanel" | "thread";
          id: string;
          environmentId?: string;
        }>
      ).detail;
      if (detail.kind === "thread" && detail.environmentId) {
        initialWorkspace.current = null;
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: detail.environmentId, threadId: detail.id },
          hash: "",
        });
      }
      if (
        detail.kind === "workspace" &&
        (detail.id === "chat" || findExtensionSlot(detail.id, "workspace"))
      ) {
        const target = pathname.startsWith("/settings") ? "/" : pathname;
        initialWorkspace.current = target === "/" && detail.id !== "chat" ? detail.id : null;
        void navigate({
          to: target,
          hash: workspaceHash(detail.id),
          search: true,
        });
      }
      if (detail.kind === "rightPanel" && threadRef && findExtensionSlot(detail.id, "rightPanel")) {
        activateExtensionPanel(threadRef, detail.id);
      }
    };
    window.addEventListener(NAVIGATION_EVENT, listener);
    return () => window.removeEventListener(NAVIGATION_EVENT, listener);
  }, [navigate, pathname, threadRef]);
  useEffect(() => {
    const workspace = defaultWorkspace.current;
    if (entries === extensionSlots) defaultLandingConsumed = true;
    defaultWorkspace.current = undefined;
    if (workspace) openWorkspace(workspace);
  }, [entries]);
  return null;
}
