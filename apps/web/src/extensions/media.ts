export function createMediaUrlCache() {
  const urls = new Map<string, { url: string; expiresAt: number }>();
  const pending = new Map<string, Promise<{ url: string; expiresAt: number }>>();
  return async (
    key: string,
    issue: () => Promise<{ url: string; expiresAt: number; ttlMs?: number | undefined }>,
    now = Date.now(),
  ) => {
    const cached = urls.get(key);
    if (cached && cached.expiresAt > now + 60_000) return cached;
    urls.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    const request = issue()
      .then((issued) => {
        const value = { url: issued.url, expiresAt: now + Math.max(0, issued.ttlMs ?? 60_000) };
        urls.set(key, value);
        if (urls.size > 1000) urls.delete(urls.keys().next().value!);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}

export const extensionMediaUrls = createMediaUrlCache();

export function mediaRefreshDelay(expiresAt: number, now = Date.now()) {
  return Math.max(60_000, expiresAt - now - 60_000);
}
