import type { ComponentType } from "react";

export type ExtScope = "read" | "operate";
export type ExtContext = { environmentId: string; projectId?: string; threadId?: string };
export type ExtView = ComponentType<{ context: ExtContext; active: boolean }>;
type Slot = { id: string; title: string; component: ExtView };
export type ExtSlot =
  | (Slot & { kind: "workspace"; icon: ComponentType; keepAlive?: boolean })
  | (Slot & {
      kind: "rightPanel";
      icon: ComponentType;
      keepAlive?: boolean;
      available?: (context: ExtContext) => boolean;
    })
  | (Slot & { kind: "settings" });
export interface ExtensionModule {
  id: string;
  sdk: 1;
  slots: ExtSlot[];
}
