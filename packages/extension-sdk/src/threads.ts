import * as Schema from "effect/Schema";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000));
export const LaunchThreadInput = Schema.Struct({
  projectId: Schema.optional(text),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  prompt: text,
  instructions: Schema.optional(text),
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type LaunchThreadInput = typeof LaunchThreadInput.Type;
export const ThreadReceipt = Schema.Struct({ threadId: text });
export const ThreadReadResult = Schema.Struct({
  threadId: text,
  status: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      id: text,
      role: Schema.Literals(["user", "assistant", "system"]),
      text: Schema.String,
      streaming: Schema.Boolean,
    }),
  ),
  after: Schema.NullOr(Schema.String),
});
export type ThreadReadResult = typeof ThreadReadResult.Type;
export const SendThreadInput = Schema.Struct({ text });
export const THREADS_PATH = "/.t4/threads";
const decodeLaunch = Schema.decodeSync(LaunchThreadInput);
const decodeReceipt = Schema.decodeUnknownSync(ThreadReceipt);
const decodeSend = Schema.decodeSync(SendThreadInput);
const decodeRead = Schema.decodeUnknownSync(ThreadReadResult);

export function createThreadClient(fetch: (path: string, init?: RequestInit) => Promise<Response>) {
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok) throw new Error(`Extension thread request failed (${response.status}).`);
    return response;
  };
  return {
    async launchThread(input: LaunchThreadInput): Promise<string> {
      const validated = decodeLaunch(input);
      return decodeReceipt(await (await request(THREADS_PATH, validated)).json()).threadId;
    },
    async sendToThread(threadId: string, text: string): Promise<void> {
      await request(
        `${THREADS_PATH}/${encodeURIComponent(threadId)}/messages`,
        decodeSend({ text }),
      );
    },
    async readThread(
      threadId: string,
      options: { after?: string } = {},
    ): Promise<ThreadReadResult> {
      const query =
        options.after === undefined ? "" : `?after=${encodeURIComponent(options.after)}`;
      return decodeRead(
        await (await request(`${THREADS_PATH}/${encodeURIComponent(threadId)}${query}`)).json(),
      );
    },
  };
}

/** Backend callers use their per-launch bearer. Supply the host origin from the proxied request. */
export function createBackendThreadClient(options: {
  hostUrl: string;
  extensionId: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}) {
  const origin = new URL(options.hostUrl).origin;
  return createThreadClient((path, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${options.token}`);
    return (options.fetch ?? globalThis.fetch)(
      `${origin}/ext/${encodeURIComponent(options.extensionId)}${path}`,
      { ...init, redirect: "error", headers },
    );
  });
}
