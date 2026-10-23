import { createThreadClient, THREADS_PATH } from "@t3tools/extension-sdk/threads";
import type { ExtensionEvent } from "@t3tools/extension-sdk/protocol";
import { useExtensionRuntime } from "./context";
import { extensionEventStreams } from "./events";
import { openExtensionThread } from "./navigation";

export function useExtThreads() {
  const { extensionId, context, fetch } = useExtensionRuntime();
  const environmentId = context.environmentId;
  const client = createThreadClient(fetch);
  return {
    ...client,
    subscribeThread(threadId: string, onEvent: (event: ExtensionEvent) => void) {
      const streamFetch = (path: string, init?: RequestInit) =>
        fetch(`${THREADS_PATH}/${encodeURIComponent(threadId)}${path}`, init);
      return extensionEventStreams.subscribe(
        `${environmentId}:${extensionId}:thread:${threadId}`,
        streamFetch,
        `thread:${threadId}`,
        onEvent,
      );
    },
    async openThread(threadId: string) {
      // The host verifies ownership before the client navigates, including across environments.
      await client.readThread(threadId);
      openExtensionThread(environmentId, threadId);
    },
  };
}
