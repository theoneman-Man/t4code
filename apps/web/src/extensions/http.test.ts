import { expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { EnvironmentId } from "@t3tools/contracts";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { fetchEnvironmentExtensionHttp } from "@t3tools/client-runtime/state/extension-http";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { extensionPath, fetchEnvironmentPath } from "./http";
import { createEventStreams } from "./events";

const connectionAtoms = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return Atom.family((_id: string) => Atom.make(Option.none<PreparedConnection>()));
});

vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../state/session", () => ({
  environmentSession: { preparedConnectionValueAtom: connectionAtoms },
}));
vi.mock("@t3tools/client-runtime/state/extension-http", () => ({
  fetchEnvironmentExtensionHttp: vi.fn(),
}));

function setup(name: string) {
  const id = EnvironmentId.make(name);
  const atom = connectionAtoms(id);
  const unmount = appAtomRegistry.mount(atom);
  const target = new PrimaryConnectionTarget({
    environmentId: id,
    label: "Test",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test/ws",
  });
  const prepared: PreparedConnection = {
    environmentId: id,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
    target,
  };
  const request = vi.mocked(fetchEnvironmentExtensionHttp).mockReset();
  request.mockImplementation(() => Effect.succeed(Response.json({ ready: true })));
  const setPrepared = (value: PreparedConnection | null) =>
    appAtomRegistry.set(atom, Option.fromNullishOr(value));
  setPrepared(null);
  return { id, prepared, request, setPrepared, [Symbol.dispose]: unmount };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps backend paths inside the extension proxy", () => {
  expect(() => extensionPath("sample", "#review-image-1")).toThrow();
  expect(extensionPath("sample", "/hello?name=a%20b")).toBe("/ext/sample/hello?name=a%20b");
  for (const path of [
    "https://other.test",
    "//other.test",
    "/../other",
    "/%2e%2e/other",
    "/hello#fragment",
    "/\\other",
  ])
    expect(() => extensionPath("sample", path)).toThrow();
});

it("waits for this environment to be prepared before requesting extension data", async () => {
  using state = setup("starting");
  const { id, prepared, request, setPrepared } = state;
  const pending = fetchEnvironmentPath(id, "/ext/sample/hello");
  expect(request).not.toHaveBeenCalled();
  appAtomRegistry.set(
    connectionAtoms("other"),
    Option.some({ ...prepared, environmentId: EnvironmentId.make("other") }),
  );
  expect(request).not.toHaveBeenCalled();
  setPrepared(prepared);
  expect(await (await pending).json()).toEqual({ ready: true });
  expect(request).toHaveBeenCalledExactlyOnceWith(prepared, "/ext/sample/hello", {});
});

it("cancels a pending connection wait without sending a later request", async () => {
  using state = setup("cancelled");
  const { id, prepared, request, setPrepared } = state;
  const abort = new AbortController();
  const pending = expect(
    fetchEnvironmentPath(id, "/ext/sample/hello", { signal: abort.signal }),
  ).rejects.toThrow();
  abort.abort();
  await pending;
  setPrepared(prepared);
  expect(request).not.toHaveBeenCalled();
});

it("reports a clear error if preparation does not finish in 30 seconds", async () => {
  using state = setup("unavailable");
  const { id, request } = state;
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  const pending = fetchEnvironmentPath(id, "/ext/sample/hello").catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await pending).toMatchObject({
    message: "Extension environment connection was not ready within 30 seconds.",
  });
  expect(request).not.toHaveBeenCalled();
});

it("connects and resumes event streams when preparation finishes after startup and restart", async () => {
  using state = setup("events");
  const { id, prepared, request, setPrepared } = state;
  const retries = deferred<() => void>();
  const streams = createEventStreams((run) => {
    retries.resolve(run);
    return () => {};
  });
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  request.mockImplementation(() =>
    Effect.sync(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
            },
          }),
        ),
    ),
  );
  const first = deferred<void>();
  const resumed = deferred<void>();
  const events = vi.fn((event) => {
    if (event.cursor === "one") first.resolve();
    if (event.cursor === "two") resumed.resolve();
  });
  const connected = deferred<void>();
  const fetch = async (path: string, init?: RequestInit) => {
    const response = await fetchEnvironmentPath(id, `/ext/sample${path}`, init);
    connected.resolve();
    return response;
  };
  const stop = streams.subscribe(`${id}:sample`, fetch, "tick", events);
  using _subscription = { [Symbol.dispose]: stop };
  expect(request).not.toHaveBeenCalled();
  setPrepared(prepared);
  await connected.promise;
  controllers[0]!.enqueue(new TextEncoder().encode("id: one\nevent: tick\ndata: 1\n\n"));
  await first.promise;
  setPrepared(null);
  controllers[0]!.close();
  const retry = await retries.promise;
  retry();
  expect(request).toHaveBeenCalledTimes(1);
  const nextConnected = deferred<void>();
  request.mockImplementationOnce(() =>
    Effect.sync(() => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
          },
        }),
      );
      nextConnected.resolve();
      return response;
    }),
  );
  setPrepared({ ...prepared, socketUrl: `${prepared.socketUrl}?restarted` });
  await nextConnected.promise;
  controllers[1]!.enqueue(new TextEncoder().encode("id: two\nevent: tick\ndata: 2\n\n"));
  await resumed.promise;
  expect(request.mock.calls[1]![1]).toBe("/ext/sample/events?cursor=one");
  expect(events.mock.calls.map(([event]) => event.data)).toEqual([1, 2]);
});
