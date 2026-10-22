const listeners = new Map<string, Set<() => void>>();

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
