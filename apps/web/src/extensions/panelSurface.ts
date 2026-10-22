import { findExtensionSlot } from "./registry";
import type { ThreadRightPanelState } from "../rightPanelStore";

export type ExtensionPanelSurface = { id: `ext:${string}`; kind: "extension"; slotKey: string };
export function extensionPanelSurface(slotKey: string): ExtensionPanelSurface | null {
  return findExtensionSlot(slotKey, "rightPanel")
    ? { id: `ext:${slotKey}`, kind: "extension", slotKey }
    : null;
}
export function restoreExtensionPanel(
  surface: ExtensionPanelSurface,
): ExtensionPanelSurface | null {
  return typeof surface.slotKey === "string" && surface.id === `ext:${surface.slotKey}`
    ? extensionPanelSurface(surface.slotKey)
    : null;
}

export function removeUnknownExtensionPanels(byThreadKey: Record<string, ThreadRightPanelState>) {
  let result = byThreadKey;
  for (const [key, state] of Object.entries(byThreadKey ?? {})) {
    if (!Array.isArray(state?.surfaces)) continue;
    const surfaces = state.surfaces.filter(
      (surface) => surface.kind !== "extension" || restoreExtensionPanel(surface) !== null,
    );
    if (surfaces.length === state.surfaces.length) continue;
    if (result === byThreadKey) result = { ...byThreadKey };
    const removedSelection = state.surfaces.some(
      (surface) => surface.id === state.activeSurfaceId && !surfaces.includes(surface),
    );
    result[key] = {
      ...state,
      surfaces,
      ...(removedSelection ? { activeSurfaceId: surfaces[0]?.id ?? null } : {}),
    };
  }
  return result;
}
