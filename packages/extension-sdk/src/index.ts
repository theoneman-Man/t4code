// oxlint-disable-next-line typescript/triple-slash-reference -- Ambient CSS declarations must follow the SDK into an external tsconfig without emitting a runtime import.
/// <reference path="./assets.d.ts" />
// Vite replaces this declaration entry with the host runtime. Node consumers use the pure subpaths.
export * from "./manifest.ts";
export * from "./protocol.ts";
export * from "./threads.ts";
export declare function useExtThreads(): ReturnType<
  typeof import("./threads.ts").createThreadClient
> & {
  subscribeThread(threadId: string, onEvent: (event: ExtensionEvent) => void): () => void;
  openThread(threadId: string): Promise<void>;
};
export type * from "./types.ts";
import type { ExtContext } from "./types.ts";
import type { ExtensionEvent } from "./protocol.ts";
export declare function useExtContext(): ExtContext;
export declare function useTheme(): "light" | "dark";
export declare function useExtFetch(): (path: string, init?: RequestInit) => Promise<Response>;
export declare function useExtEvents(topic: string, onEvent: (event: ExtensionEvent) => void): void;
/** Returns a shared signed URL for lazy media loading; falls back to a blob if issuance fails. */
export declare function useExtMediaUrl(path: string): string | null;
/** Slot addresses are "<extension id>:<slot id>". Pass "chat" to restore chat. */
export declare function openWorkspace(id: string): void;
export declare function openPanel(id: string): void;
export * from "./ui.ts";
