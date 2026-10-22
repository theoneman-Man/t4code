import type { ExtensionEvent } from "@t3tools/extension-sdk";
import { refreshExtensionStatus } from "./status";

export type ExtFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function createSseParser(onEvent: (event: ExtensionEvent) => void, initialCursor = "") {
  let pending = "";
  let cursor = initialCursor;
  let topic = "message";
  let data: string[] = [];
  const line = (value: string) => {
    if (value === "") {
      if (data.length) {
        try {
          onEvent({ topic, cursor, data: JSON.parse(data.join("\n")) });
        } catch {
          /* Malformed backend data must not terminate the stream. */
        }
      }
      topic = "message";
      data = [];
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
    if (field === "id" && !content.includes("\0")) cursor = content;
    if (field === "event") topic = content || "message";
    if (field === "data") data.push(content);
  };
  return {
    push(chunk: string) {
      pending += chunk;
      for (;;) {
        const end = pending.search(/[\r\n]/);
        if (end < 0 || (pending[end] === "\r" && end === pending.length - 1)) break;
        const size = pending[end] === "\r" && pending[end + 1] === "\n" ? 2 : 1;
        line(pending.slice(0, end));
        pending = pending.slice(end + size);
      }
    },
    get cursor() {
      return cursor;
    },
  };
}

type Subscriber = { topic: string; onEvent: (event: ExtensionEvent) => void };
type StreamState = { subscribers: Set<Subscriber>; stop: () => void };

export function createEventStreams(
  schedule: (run: () => void, delay: number) => () => void = (run, delay) => {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
  onReconnect: (key: string) => void = () => {},
) {
  const streams = new Map<string, StreamState>();
  return {
    subscribe(key: string, fetch: ExtFetch, topic: string, onEvent: Subscriber["onEvent"]) {
      let state = streams.get(key);
      if (!state) {
        const subscribers = new Set<Subscriber>();
        const abort = new AbortController();
        let cancelRetry = () => {};
        let cursor = "";
        let failures = 0;
        let attempted = false;
        const connect = async () => {
          const reconnect = attempted;
          attempted = true;
          const parser = createSseParser((event) => {
            failures = 0;
            for (const subscriber of subscribers) {
              if (subscriber.topic === event.topic || event.topic === "reset") {
                try {
                  subscriber.onEvent(event);
                } catch (error) {
                  console.error("Extension event subscriber failed.", error);
                }
              }
            }
          }, cursor);
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          const cancelReader = () => {
            void reader?.cancel().catch(() => {});
          };
          try {
            const response = await fetch(
              `/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
              {
                signal: abort.signal,
                headers: { accept: "text/event-stream" },
              },
            );
            if (!response.ok || !response.body)
              throw new Error("Extension event stream unavailable.");
            if (reconnect) onReconnect(key);
            reader = response.body.getReader();
            abort.signal.addEventListener("abort", cancelReader, { once: true });
            if (abort.signal.aborted) return;
            const decoder = new TextDecoder();
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done || abort.signal.aborted) break;
              parser.push(decoder.decode(chunk.value, { stream: true }));
            }
          } catch {
            /* EOF and network errors share the same bounded reconnect path. */
          } finally {
            abort.signal.removeEventListener("abort", cancelReader);
            cursor = parser.cursor;
            await reader?.cancel().catch(() => {});
            reader?.releaseLock();
          }
          if (!abort.signal.aborted) {
            cancelRetry = schedule(
              () => void connect(),
              Math.min(30_000, 500 * 2 ** Math.min(failures++, 6)),
            );
          }
        };
        state = {
          subscribers,
          stop: () => {
            abort.abort();
            cancelRetry();
          },
        };
        streams.set(key, state);
        void connect();
      }
      const subscriber = { topic, onEvent };
      state.subscribers.add(subscriber);
      return () => {
        state.subscribers.delete(subscriber);
        if (state.subscribers.size === 0) {
          state.stop();
          streams.delete(key);
        }
      };
    },
  };
}

export const extensionEventStreams = createEventStreams(undefined, refreshExtensionStatus);
