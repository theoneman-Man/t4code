import * as NodeURL from "node:url";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerHttp from "../http.ts";
import * as ExtensionHost from "./ExtensionHost.ts";
import * as ExtensionHttp from "./http.ts";

const fixtureRoot = NodeURL.fileURLToPath(
  new URL("../../../../packages/extension-sdk/fixtures/sample", import.meta.url),
);

const harness = Effect.fn("ExtensionTest.harness")(function* (
  empty = false,
  listContents?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-extension-" });
  const listFile = path.join(directory, "t4.extensions.json");
  const dataDir = path.join(directory, "data");
  if (!empty) yield* fs.writeFileString(listFile, JSON.stringify([{ path: fixtureRoot, dataDir }]));
  if (listContents !== undefined) yield* fs.writeFileString(listFile, listContents);
  const dependencies = Layer.mergeAll(
    ExtensionHost.layer.pipe(
      Layer.provide(Layer.succeed(ExtensionHost.Options, { hostRoot: directory })),
      Layer.provide(FetchHttpClient.layer),
    ),
    EnvironmentAuth.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(directory, path.join(directory, "home"))),
    Layer.provideMerge(NodeServices.layer),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.merge(
        ExtensionHttp.layer.pipe(Layer.provide(FetchHttpClient.layer)),
        ServerHttp.layerHttpCompression,
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(dependencies), Layer.provideMerge(NodeHttpServer.layerTest)),
  );
  const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
  const host = Context.get(services, ExtensionHost.ExtensionHost);
  const client = Context.get(services, HttpClient.HttpClient);
  const read = yield* auth.issueSession({ scopes: [AuthOrchestrationReadScope] });
  const operate = yield* auth.issueSession({
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  });
  return {
    host,
    client,
    dataDir,
    listFile,
    config: Context.get(services, ServerConfig.ServerConfig),
    read: { authorization: `Bearer ${read.token}` },
    operate: { authorization: `Bearer ${operate.token}` },
  };
});

it.live("starts, authorizes, streams ticks, restarts and stops the real backend", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pid = yield* Effect.scoped(
      Effect.gen(function* () {
        const { host, client, dataDir, listFile, config, read, operate } = yield* harness();
        yield* host.awaitState("sample", "ready");
        const first = yield* host.backend("sample");
        expect(first).toBeDefined();
        if (!first) return yield* Effect.die("Fixture did not become ready");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const borrowedContext = yield* Layer.build(
              ExtensionHost.layerWithOptions({
                listFile,
                descriptors: [{ ...first, url: `${first.url}/` }],
              }).pipe(
                Layer.provide(ServerConfig.layer(config)),
                Layer.provide(FetchHttpClient.layer),
              ),
            );
            const borrowed = Context.get(borrowedContext, ExtensionHost.ExtensionHost);
            yield* borrowed.awaitState("sample", "ready");
            expect((yield* borrowed.backend("sample"))?.instanceId).toBe(first.instanceId);
          }),
        );
        // Closing a borrowing server must leave the original owner's child alive.
        const hello = yield* client.get("/ext/sample/hello", { headers: read });
        expect(yield* hello.json).toEqual({ message: "hello from sample" });
        const denied = yield* client.post("/ext/sample/echo", { headers: read });
        expect(denied.status).toBe(403);
        expect(yield* denied.json).toMatchObject({
          code: "insufficient_scope",
          requiredScope: "orchestration:operate",
        });
        const echo = yield* client.execute(
          HttpClientRequest.post("/ext/sample/echo", { headers: operate }).pipe(
            HttpClientRequest.bodyJsonUnsafe({ value: 42 }),
          ),
        );
        expect(yield* echo.json).toEqual({ body: { value: 42 }, scope: "operate" });
        const connected = yield* Deferred.make<void>();
        const events = yield* client.get("/ext/sample/events?cursor=0", {
          headers: { ...read, "accept-encoding": "gzip, br" },
        });
        expect(events.headers["content-encoding"]).toBeUndefined();
        const tick = yield* events.stream.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.tap((line) =>
            line === ": heartbeat" ? Deferred.succeed(connected, undefined) : Effect.void,
          ),
          Stream.filter((line) => line.startsWith("data:")),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Deferred.await(connected);
        const emitted = yield* client.post("/ext/sample/tick", { headers: operate });
        expect(yield* emitted.json).toEqual({ n: 1 });
        expect(yield* Fiber.join(tick)).toEqual(Option.some('data: {"n":1}'));
        const restarting = yield* host.awaitState("sample", "restarting").pipe(Effect.forkScoped);
        const crash = yield* client.post("/ext/sample/crash", { headers: operate });
        yield* crash.text;
        yield* Fiber.join(restarting);
        yield* host.awaitState("sample", "ready");
        const second = yield* host.backend("sample");
        expect(second?.instanceId).not.toBe(first?.instanceId);
        const again = yield* client.get("/ext/sample/hello", { headers: read });
        expect(yield* again.json).toEqual({ message: "hello from sample" });
        const status = yield* client.get("/api/extensions", { headers: read });
        expect(yield* status.json).toEqual({ extensions: [{ id: "sample", backend: "ready" }] });
        return Number(yield* fs.readFileString(path.join(dataDir, "backend.pid")));
      }),
    );
    expect(() => process.kill(pid, 0)).toThrow();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a missing list leaves no extensions and authenticates the empty routes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, client, read } = yield* harness(true);
      expect(yield* host.status).toEqual({ extensions: [] });
      const status = yield* client.get("/api/extensions", { headers: read });
      expect(yield* status.json).toEqual({ extensions: [] });
      expect((yield* client.get("/ext/sample/hello", { headers: read })).status).toBe(404);
      expect((yield* client.get("/api/extensions")).status).toBe(401);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([
  { contents: "secret-value", reason: "Invalid JSON in extension configuration." },
  {
    contents: '{"extensions":"secret-value"}',
    reason: "Extension list or manifest validation failed.",
  },
  { contents: '["./missing"]', reason: "An extension manifest is missing." },
])("a bad list keeps routes available and logs a safe reason: $reason", ({ contents, reason }) => {
  const logs: Array<{ level: string; message: unknown }> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message });
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const { host, client, read, listFile } = yield* harness(true, contents);
      expect(yield* host.status).toEqual({ extensions: [] });
      const status = yield* client.get("/api/extensions", { headers: read });
      expect(yield* status.json).toEqual({ extensions: [] });
      expect((yield* client.get("/ext/sample/hello", { headers: read })).status).toBe(404);
      expect(logs.filter((entry) => entry.level === "Error")).toEqual([
        {
          level: "Error",
          message: [
            "Extensions disabled: failed to load extension configuration.",
            { path: listFile, reason },
          ],
        },
      ]);
      expect(JSON.stringify(logs)).not.toContain("secret-value");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(Logger.layer([logger], { mergeWithExisting: false }), NodeServices.layer),
    ),
  );
});

it.live("rejects a mismatched borrowed readiness identity without launching a child", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-extension-failure-" });
      const dataDir = path.join(directory, "data");
      const listFile = path.join(directory, "t4.extensions.json");
      yield* fs.writeFileString(listFile, JSON.stringify([{ path: fixtureRoot, dataDir }]));
      const backendServices = yield* Layer.build(
        HttpRouter.serve(
          HttpRouter.use((router) =>
            router.add(
              "GET",
              "/.t4/ready",
              HttpServerResponse.jsonUnsafe({
                protocol: 1,
                extensionId: "wrong",
                instanceId: "instance",
                dataDir,
              }),
            ),
          ),
          { disableLogger: true, disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const address = Context.get(backendServices, HttpServer.HttpServer).address;
      if (!("port" in address)) return yield* Effect.die("Expected TCP address");
      const services = yield* Layer.build(
        ExtensionHost.layerWithOptions({
          listFile,
          descriptors: [
            {
              extensionId: "sample",
              url: `http://127.0.0.1:${address.port}`,
              token: "fixture-token",
              instanceId: "instance",
              dataDir,
            },
          ],
        }).pipe(
          Layer.provideMerge(ServerConfig.layerTest(directory, path.join(directory, "home"))),
          Layer.provide(FetchHttpClient.layer),
        ),
      );
      const host = Context.get(services, ExtensionHost.ExtensionHost);
      yield* host.awaitState("sample", "failed");
      expect(yield* host.backend("sample")).toBeUndefined();
      expect(yield* host.status).toEqual({
        extensions: [{ id: "sample", backend: "failed", message: "Backend readiness failed." }],
      });
      const config = Context.get(services, ServerConfig.ServerConfig);
      expect(yield* fs.exists(path.join(config.logsDir, "extensions", "sample.log"))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it("removes inherited host credentials before launching", () => {
  const env = ExtensionHost.backendEnvironment(
    { PATH: "bin", T3CODE_DEV_AUTH_TOKEN: "host", T4_TOKEN: "host", T4_EXT_TOKEN: "old" },
    {
      extensionId: "sample",
      url: "http://127.0.0.1:1234",
      token: "launch",
      instanceId: "instance",
      dataDir: "/data",
    },
  );
  expect(env).toEqual({
    PATH: "bin",
    T4_EXT_ID: "sample",
    T4_EXT_PORT: "1234",
    T4_EXT_TOKEN: "launch",
    T4_EXT_INSTANCE: "instance",
    T4_EXT_DATA_DIR: "/data",
  });
});
