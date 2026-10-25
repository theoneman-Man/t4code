import { expect, it, vi } from "vite-plus/test";
import { createMediaUrlCache, mediaRefreshDelay } from "./media";

it("shares signed URLs across mounts and deduplicates concurrent issuance", async () => {
  const cache = createMediaUrlCache();
  const issue = vi.fn(async () => ({
    url: "https://host/api/assets/signed/media",
    expiresAt: 100_000,
    ttlMs: 100_000,
  }));
  const [first, second] = await Promise.all([
    cache("env:sample:/file", issue, 0),
    cache("env:sample:/file", issue, 0),
  ]);
  expect(first).toEqual(second);
  expect(await cache("env:sample:/file", issue, 10_000)).toBe(first);
  expect(issue).toHaveBeenCalledTimes(1);
  await cache("other:sample:/file", issue, 10_000);
  expect(issue).toHaveBeenCalledTimes(2);
  await cache("env:sample:/file", issue, 50_000);
  expect(issue).toHaveBeenCalledTimes(3);
});

it("allows retry after issuance fails", async () => {
  const cache = createMediaUrlCache();
  await expect(cache("key", () => Promise.reject(new Error("offline")), 0)).rejects.toThrow(
    "offline",
  );
  expect(
    await cache("key", async () => ({ url: "signed", expiresAt: 100_000, ttlMs: 100_000 }), 0),
  ).toEqual({
    url: "signed",
    expiresAt: 100_000,
  });
});

it("uses remaining server TTL despite clock skew and never refreshes faster than once a minute", async () => {
  for (const expiresAt of [0, 9_000_000_000]) {
    const cache = createMediaUrlCache();
    const issue = vi.fn(async () => ({ url: "signed", expiresAt, ttlMs: 6 * 60 * 60_000 }));
    const value = await cache("key", issue, 10_000);
    expect(value.expiresAt).toBe(10_000 + 6 * 60 * 60_000);
    expect(mediaRefreshDelay(value.expiresAt, 10_000)).toBe(6 * 60 * 60_000 - 60_000);
    await cache("key", issue, 100_000);
    expect(issue).toHaveBeenCalledTimes(1);
  }
  expect(mediaRefreshDelay(0, 10_000)).toBe(60_000);
  expect(mediaRefreshDelay(70_001, 10_000)).toBe(60_000);
});
