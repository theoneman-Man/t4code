// @effect-diagnostics nodeBuiltinImport:off -- Real sockets reproduce pre-header resets and interrupted response streams.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import type { ExtensionBackendLifecycle } from "@t3tools/extension-sdk/protocol";
import * as ExtensionHost from "./ExtensionHost.ts";
import * as ExtensionProxy from "./ExtensionProxy.ts";

const target = { id: "sample", path: "/file", search: "?key=query-secret", scope: "read" as const };

const holdingHarness = Effect.fn("ExtensionProxyTest.holdingHarness")(function* () {
  let lifecycle: ExtensionBackendLifecycle = { state: "reloading", since: 0 };
  const waiting = yield* Deferred.make<void>();
  const ready = yield* Deferred.make<void>();
  const forwarded: string[] = [];
  const host = ExtensionHost.ExtensionHost.of({
    threadHostUrl: "http://127.0.0.1:1234",
    hasThreadPermission: () => Effect.succeed(false),
    status: Effect.succeed({ extensions: [] }),
    resolveRoute: () => Effect.succeed(target),
    lifecycle: () => Effect.sync(() => lifecycle),
    restart: () => Effect.succeed(undefined),
    backend: () =>
      Effect.succeed({
        extensionId: "sample",
        url: "http://127.0.0.1:12345",
        token: "fixture",
        instanceId: "one",
        dataDir: "unused",
      }),
    awaitState: () =>
      Deferred.succeed(waiting, undefined).pipe(
        Effect.andThen(Deferred.await(ready)),
        Effect.as({ id: "sample", backend: "ready" as const }),
      ),
  });
  const client = HttpClient.make((request) => {
    forwarded.push(request.method);
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok")));
  });
  const services = yield* Layer.build(
    ExtensionProxy.layer.pipe(
      Layer.provide(Layer.succeed(ExtensionHost.ExtensionHost, host)),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ),
  );
  return {
    proxy: Context.get(services, ExtensionProxy.ExtensionProxy),
    waiting,
    forwarded,
    ready: Effect.sync(() => {
      lifecycle = { state: "ready", since: 1 };
    }).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
  };
});

it.effect.each([
  { method: "GET", key: "" },
  { method: "HEAD", key: "" },
  { method: "POST", key: "Idempotency-Key" },
  { method: "POST", key: "x-request-id" },
])("holds $method until ready, with $key for writes", ({ method, key }) =>
  Effect.gen(function* () {
    const test = yield* holdingHarness();
    const request = HttpServerRequest.fromWeb(
      new Request("http://host/ext/sample/file", {
        method,
        ...(method === "POST" ? { headers: { [key]: "operation-1" }, body: "payload" } : {}),
      }),
    );
    const pending = yield* test.proxy.forward(request, target).pipe(Effect.forkScoped);
    yield* Deferred.await(test.waiting);
    expect(test.forwarded).toEqual([]);
    yield* test.ready;
    expect((yield* Fiber.join(pending)).status).toBe(200);
    expect(test.forwarded).toEqual([method]);
  }),
);

it.effect("stops holding after twenty seconds without forwarding", () =>
  Effect.gen(function* () {
    const test = yield* holdingHarness();
    const pending = yield* test.proxy.forward(incoming("GET"), target).pipe(Effect.forkScoped);
    yield* Deferred.await(test.waiting);
    yield* TestClock.adjust(20_000);
    expect((yield* Fiber.join(pending)).status).toBe(503);
    expect(test.forwarded).toEqual([]);
  }),
);

it.effect("rejects a POST without a key with lifecycle JSON and retry headers", () =>
  Effect.gen(function* () {
    const test = yield* holdingHarness();
    const response = yield* test.proxy.forward(incoming("POST"), target);
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).json())).toEqual({
      state: "reloading",
      retryAfterMs: 1000,
    });
    expect(test.forwarded).toEqual([]);
  }),
);
const incoming = (method: string) =>
  HttpServerRequest.fromWeb(
    new Request(`http://host/ext/sample/file${target.search}`, {
      method,
      headers: { authorization: "Bearer client-secret" },
      ...(method === "GET" || method === "HEAD" ? {} : { body: "streamed body" }),
    }),
  );

const harness = Effect.fn("ExtensionProxyTest.harness")(function* (
  handler: NodeHttp.RequestListener,
  clientLayer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
  available = true,
) {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => NodeHttp.createServer(handler)),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") return yield* Effect.die("Expected TCP address");
  const host = ExtensionHost.ExtensionHost.of({
    threadHostUrl: "http://127.0.0.1:1234",
    hasThreadPermission: () => Effect.succeed(false),
    backend: () =>
      Effect.succeed(
        available
          ? {
              extensionId: "sample",
              url: `http://127.0.0.1:${address.port}`,
              token: "backend-secret",
              instanceId: "test",
              dataDir: "unused",
            }
          : undefined,
      ),
    status: Effect.succeed({ extensions: [] }),
    lifecycle: () => Effect.succeed(undefined),
    restart: () => Effect.succeed(undefined),
    resolveRoute: () => Effect.succeed(target),
    awaitState: () => Effect.succeed({ id: "sample", backend: "ready" }),
  });
  const services = yield* Layer.build(
    ExtensionProxy.layer.pipe(
      Layer.provide(clientLayer),
      Layer.provide(Layer.succeed(ExtensionHost.ExtensionHost, host)),
    ),
  );
  return Context.get(services, ExtensionProxy.ExtensionProxy);
});

it.live.each(["GET", "HEAD"])(
  "retries %s once on a fresh connection after a pre-header reset",
  (method) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sockets: NodeNet.Socket[] = [];
        const proxy = yield* harness((request, response) => {
          sockets.push(request.socket);
          if (sockets.length === 1) request.socket.destroy();
          else response.end("recovered");
        });
        const response = yield* proxy.forward(incoming(method), target);
        expect(response.status).toBe(200);
        expect(sockets).toHaveLength(2);
        expect(sockets[1]).not.toBe(sockets[0]);
        if (response.body._tag !== "Stream") return yield* Effect.die("Expected streaming body");
        const body = yield* response.body.stream.pipe(
          Stream.decodeText(),
          Stream.runCollect,
          Effect.orDie,
        );
        expect(body.join("")).toBe(method === "HEAD" ? "" : "recovered");
      }),
    ),
);

it.live.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
  "never retries %s with a streamed request body",
  (method) =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        const proxy = yield* harness((request) => {
          attempts++;
          request.socket.destroy();
        });
        const result = yield* proxy.forward(incoming(method), target).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(attempts).toBe(1);
      }),
    ),
);

it.live("stops after one retry and logs only safe request and error fields", () => {
  const logs: Array<{ level: string; message: unknown }> = [];
  const logger = Logger.make(({ logLevel, message }) => logs.push({ level: logLevel, message }));
  return Effect.scoped(
    Effect.gen(function* () {
      let attempts = 0;
      const proxy = yield* harness((request) => {
        attempts++;
        request.socket.destroy();
      });
      const result = yield* proxy.forward(incoming("GET"), target).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(attempts).toBe(2);
      expect(logs).toContainEqual({
        level: "Warn",
        message: [
          "Extension proxy request failed.",
          {
            extensionId: "sample",
            method: "GET",
            path: "/file",
            errorTag: "HttpClientError",
            reason: "TransportError",
          },
        ],
      });
      expect(JSON.stringify(logs)).not.toContain("secret");
      expect(JSON.stringify(logs)).not.toContain("?key");
    }),
  ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.live("does not retry a non-transport client failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attempts = 0;
      const client = HttpClient.make((request) => {
        attempts++;
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.EncodeError({ request, cause: "error-secret" }),
          }),
        );
      });
      const proxy = yield* harness(() => {}, Layer.succeed(HttpClient.HttpClient, client));
      expect(Exit.isFailure(yield* proxy.forward(incoming("GET"), target).pipe(Effect.exit))).toBe(
        true,
      );
      expect(attempts).toBe(1);
    }),
  ),
);

it.live("does not retry an upstream error status", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attempts = 0;
      const proxy = yield* harness((_request, response) => {
        attempts++;
        response.writeHead(503);
        response.end();
      });
      expect((yield* proxy.forward(incoming("GET"), target)).status).toBe(503);
      expect(attempts).toBe(1);
    }),
  ),
);

it.live("never retries after headers and logs a response stream failure", () => {
  const logs: Array<{ level: string; message: unknown }> = [];
  const logger = Logger.make(({ logLevel, message }) => logs.push({ level: logLevel, message }));
  return Effect.scoped(
    Effect.gen(function* () {
      let attempts = 0;
      let upstream: NodeHttp.ServerResponse | undefined;
      const chunkReceived = yield* Deferred.make<void>();
      const proxy = yield* harness((_request, response) => {
        attempts++;
        upstream = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
      });
      const response = yield* proxy.forward(incoming("GET"), target);
      expect(response.status).toBe(200);
      if (response.body._tag !== "Stream") return yield* Effect.die("Expected streaming body");
      const reader = yield* response.body.stream.pipe(
        Stream.tap(() => Deferred.succeed(chunkReceived, undefined)),
        Stream.runDrain,
        Effect.exit,
        Effect.forkScoped,
      );
      yield* Deferred.await(chunkReceived);
      upstream!.destroy();
      expect(Exit.isFailure(yield* Fiber.join(reader))).toBe(true);
      expect(attempts).toBe(1);
      expect(logs).toContainEqual({
        level: "Warn",
        message: [
          "Extension proxy response stream failed.",
          {
            extensionId: "sample",
            method: "GET",
            path: "/file",
            errorTag: "HttpClientError",
            reason: "DecodeError",
          },
        ],
      });
      expect(JSON.stringify(logs)).not.toContain("secret");
    }),
  ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.live("logs why an unavailable backend returns 503", () => {
  const logs: Array<{ level: string; message: unknown }> = [];
  const logger = Logger.make(({ logLevel, message }) => logs.push({ level: logLevel, message }));
  return Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* harness(() => {}, FetchHttpClient.layer, false);
      expect((yield* proxy.forward(incoming("GET"), target)).status).toBe(503);
      expect(logs).toEqual([
        {
          level: "Warn",
          message: [
            "Extension proxy backend unavailable.",
            { extensionId: "sample", method: "GET", path: "/file", reason: "BackendUnavailable" },
          ],
        },
      ]);
    }),
  ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.live("forwards validators and passes cacheable 304 responses through", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* harness((request, response) => {
        expect(request.headers["if-none-match"]).toBe('"v1"');
        expect(request.headers["if-modified-since"]).toBe("Sun, 25 Oct 2026 08:00:00 GMT");
        response.writeHead(304, { etag: '"v1"', "cache-control": "private, max-age=60" });
        response.end();
      });
      const request = HttpServerRequest.fromWeb(
        new Request("http://host/ext/sample/file", {
          headers: {
            "if-none-match": '"v1"',
            "if-modified-since": "Sun, 25 Oct 2026 08:00:00 GMT",
          },
        }),
      );
      const response = yield* proxy.forward(request, target);
      expect(response.status).toBe(304);
      expect(response.headers["cache-control"]).toBe("private, max-age=60");
      expect(response.headers.etag).toBe('"v1"');
      expect(response.body._tag).toBe("Empty");
    }),
  ),
);
