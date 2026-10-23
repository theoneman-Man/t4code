import { expect, it } from "vite-plus/test";
import { createThreadClient, createBackendThreadClient } from "./threads.ts";
import { parseExtensionManifest } from "./manifest.ts";

it("declares the optional threads permission and rejects unknown permissions", () => {
  expect(
    parseExtensionManifest({ id: "sample", sdk: 1, permissions: ["threads"] }).permissions,
  ).toEqual(["threads"]);
  expect(() => parseExtensionManifest({ id: "sample", sdk: 1, permissions: ["rpc"] })).toThrow();
});

it("uses the backend launch bearer for wake-ups and refuses redirects", async () => {
  const requests: { url: string; token: string | null; redirect: RequestRedirect | undefined }[] =
    [];
  const client = createBackendThreadClient({
    hostUrl: "http://127.0.0.1:1234",
    extensionId: "sample",
    token: "fake-launch-token",
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        token: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      return Response.json({});
    },
  });
  await client.sendToThread("owned", "An event needs attention");
  expect(requests).toEqual([
    {
      url: "http://127.0.0.1:1234/ext/sample/.t4/threads/owned/messages",
      token: "Bearer fake-launch-token",
      redirect: "error",
    },
  ]);
});

it("uses only the owned-thread host paths and validates host replies", async () => {
  const requests: string[] = [];
  const client = createThreadClient(async (path) => {
    requests.push(path);
    return Response.json({ threadId: "thread-1" });
  });
  expect(
    await client.launchThread({ title: "Manager", prompt: "Review", idempotencyKey: "one" }),
  ).toBe("thread-1");
  await client.sendToThread("thread/1", "Wake up");
  expect(requests).toEqual(["/.t4/threads", "/.t4/threads/thread%2F1/messages"]);
  const invalid = createThreadClient(async () => Response.json({ threadId: 3 }));
  await expect(
    invalid.launchThread({ title: "Manager", prompt: "Review", idempotencyKey: "one" }),
  ).rejects.toThrow();
});
