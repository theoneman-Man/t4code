import type { ExtensionBackendLifecycle } from "@t3tools/extension-sdk/protocol";
import { toastManager } from "../components/ui/toast";

const listeners = new Map<string, Set<() => void>>();

export function createBackendNotifications<T>(notifier: {
  readonly down: (id: string, reason?: string) => T;
  readonly recovered: (notice: T) => void;
}) {
  const outages = new Map<string, T>();
  return (key: string, id: string, lifecycle: ExtensionBackendLifecycle) => {
    if (lifecycle.state === "down" && !outages.has(key))
      outages.set(key, notifier.down(id, lifecycle.lastError ?? lifecycle.reason));
    if (lifecycle.state === "ready" && outages.has(key)) {
      notifier.recovered(outages.get(key)!);
      outages.delete(key);
    }
  };
}

export const notifyBackendLifecycle = createBackendNotifications({
  down: (id, reason) =>
    toastManager.add({
      type: "error",
      title: `${id} backend is down`,
      description: reason ?? "Retrying automatically.",
      timeout: 0,
    }),
  recovered: (notice) => toastManager.close(notice),
});

export function subscribeExtensionStatus(key: string, refresh: () => void) {
  const subscribers = listeners.get(key) ?? new Set();
  listeners.set(key, subscribers);
  subscribers.add(refresh);
  return () => {
    subscribers.delete(refresh);
    if (!subscribers.size) listeners.delete(key);
  };
}

export function refreshExtensionStatus(key: string) {
  for (const refresh of listeners.get(key) ?? []) refresh();
}
