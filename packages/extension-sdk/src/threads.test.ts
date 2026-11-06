import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  createThreadClient,
  createBackendThreadClient,
  ThreadReadResult,
  LaunchThreadInput,
} from "./threads.ts";
import { parseExtensionManifest } from "./manifest.ts";

it("preserves an explicit workspace-write launch and rejects unrestricted modes", async () => {
  const bodies: unknown[] = [];
  const client = createThreadClient(async (_path, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ threadId: "owned" });
  });
  const input = {
    title: "Import",
    prompt: "Extract",
    idempotencyKey: "import",
    runtimeMode: "auto-accept-edits" as const,
  };
  await client.launchThread(input);
  expect(bodies).toEqual([input]);
  for (const runtimeMode of ["full-access", "auto", "invalid"]) {
    expect(() => Schema.decodeUnknownSync(LaunchThreadInput)({ ...input, runtimeMode })).toThrow();
  }
});

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

it("sends media references without copying attachments and limits media", async () => {
  const bodies: unknown[] = [];
  const client = createThreadClient(async (_path, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ threadId: "owned" });
  });
  const media = [{ path: "/files/gate.png?v=one", name: "Gate", mimeType: "image/png" }];
  await client.launchThread({ title: "Gate", prompt: "Review", idempotencyKey: "gate", media });
  await client.sendToThread("owned", "Review gate", media);
  expect(bodies).toEqual([
    { title: "Gate", prompt: "Review", idempotencyKey: "gate", media },
    { text: "Review gate", media },
  ]);
  await expect(
    client.sendToThread(
      "owned",
      "Too many",
      Array.from({ length: 25 }, () => media[0]!),
    ),
  ).rejects.toThrow();
  await expect(
    client.sendToThread("owned", "Invalid", [{ path: "https://other/image.png" }]),
  ).rejects.toThrow();
});

it("preserves the owning extension when decoding readback media", () => {
  const result = Schema.decodeUnknownSync(ThreadReadResult)({
    threadId: "owned",
    status: "idle",
    after: null,
    messages: [
      {
        id: "m",
        role: "user",
        text: "Gate",
        streaming: false,
        extensionId: "sample",
        media: [{ path: "/gate.jpg" }],
      },
    ],
  });
  expect(result.messages[0]?.extensionId).toBe("sample");
});
