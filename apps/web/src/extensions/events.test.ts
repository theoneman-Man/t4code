import { expect, it, vi } from "vite-plus/test";
import { createEventStreams, createSseParser } from "./events";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("parses split CRLF, multiline JSON, comments and cursor-only frames", () => {
  const events = vi.fn();
  const parser = createSseParser(events);
  parser.push(": heartbeat\r\nid: cursor 1\r");
  parser.push('\nevent: tick\r\ndata: {\r\ndata: "n":2}\r\n\r\n');
  parser.push("id: cursor 2\n\nevent: reset\ndata: null\n\n");
  parser.push("data: invalid json\n\n");
  expect(events.mock.calls.map(([event]) => event)).toEqual([
    { topic: "tick", cursor: "cursor 1", data: { n: 2 } },
    { topic: "reset", cursor: "cursor 2", data: null },
  ]);
  expect(parser.cursor).toBe("cursor 2");
});

it("shares streams, reconnects with cursor, broadcasts reset and cancels the last subscription", async () => {
  let retry: (() => void) | undefined;
  const scheduled = deferred<number>();
  const cancelled = vi.fn();
  const reconnected = vi.fn();
  const streams = createEventStreams((run, delay) => {
    retry = run;
    scheduled.resolve(delay);
    return cancelled;
  }, reconnected);
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const connected = deferred<void>();
  const fetch = vi.fn((_path: string, _init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
      },
    });
    if (controllers.length === 2) connected.resolve();
    return Promise.resolve(new Response(body));
  });
  const tick = vi.fn();
  const other = vi.fn();
  const stopTick = streams.subscribe("env:sample", fetch, "tick", tick);
  const stopOther = streams.subscribe("env:sample", fetch, "other", other);
  controllers[0]!.enqueue(new TextEncoder().encode('id: a/b\nevent: tick\ndata: {"n":1}\n\n'));
  controllers[0]!.close();
  expect(await scheduled.promise).toBe(500);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(reconnected).not.toHaveBeenCalled();
  expect(tick).toHaveBeenCalledWith({ cursor: "a/b", topic: "tick", data: { n: 1 } });
  expect(other).not.toHaveBeenCalled();
  retry!();
  await connected.promise;
  expect(fetch.mock.calls[1]![0]).toBe("/events?cursor=a%2Fb");
  const delivered = deferred<void>();
  const stopReset = streams.subscribe("env:sample", fetch, "third", () => delivered.resolve());
  controllers[1]!.enqueue(new TextEncoder().encode("id: b\nevent: reset\ndata: {}\n\n"));
  await delivered.promise;
  expect(reconnected).toHaveBeenCalledExactlyOnceWith("env:sample");
  expect(tick).toHaveBeenLastCalledWith({ cursor: "b", topic: "reset", data: {} });
  expect(other).toHaveBeenCalledOnce();
  stopTick();
  stopOther();
  expect(fetch.mock.calls[1]![1]!.signal!.aborted).toBe(false);
  stopReset();
  expect(fetch.mock.calls[1]![1]!.signal!.aborted).toBe(true);
  expect(cancelled).toHaveBeenCalledOnce();
});

it("isolates extension and environment keys and caps reconnect backoff", async () => {
  const retries: (() => void)[] = [];
  const delays: number[] = [];
  const notices: (() => void)[] = [];
  const streams = createEventStreams((run, delay) => {
    retries.push(run);
    delays.push(delay);
    notices.shift()?.();
    return () => {};
  });
  const fetch = vi.fn(() => Promise.reject(new Error("offline")));
  const stop = streams.subscribe("env:a", fetch, "tick", () => {});
  const next = () => new Promise<void>((resolve) => notices.push(resolve));
  await next();
  for (let attempt = 0; attempt < 8; attempt++) {
    const pending = next();
    retries.shift()!();
    await pending;
  }
  expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  stop();
  const pending = next();
  const stopB = streams.subscribe("env:b", fetch, "tick", () => {});
  await pending;
  stopB();
  expect(fetch).toHaveBeenCalledTimes(10);
});
