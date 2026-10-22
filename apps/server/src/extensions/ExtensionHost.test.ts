// @effect-diagnostics nodeBuiltinImport:off -- The bootstrap fixture must provide a real inherited-style file descriptor.
import * as NodeFS from "node:fs";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DesktopBackendBootstrap } from "@t3tools/contracts";
import type { ReadyBackendDescriptor } from "@t3tools/extension-sdk/host";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Schema from "effect/Schema";
import * as NetService from "@t3tools/shared/Net";
import { resolveServerConfig, type CliServerFlags } from "../cli/config.ts";
import * as NodeURL from "node:url";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

const encodeBootstrap = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));
const fixtureRoot = NodeURL.fileURLToPath(
  new URL("../../../../packages/extension-sdk/fixtures/sample", import.meta.url),
);

const harness = Effect.fn("ExtensionTest.harness")(function* (
  empty = false,
  listContents?: string,
  descriptors?: readonly ReadyBackendDescriptor[],
  dist = false,
  failures?: { extensionId: string; message: string }[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-extension-",
  });
  const listFile = path.join(directory, "t4.extensions.json");
  const dataDir = path.join(directory, "data");
  const runtimeRoot = descriptors === undefined ? directory : path.join(directory, "runtime");
  const moduleUrl = NodeURL.pathToFileURL(path.join(runtimeRoot, "apps/server/dist/bin.mjs"));
  if (dist) {
    yield* fs.makeDirectory(runtimeRoot, { recursive: true });
    yield* fs.writeFileString(path.join(runtimeRoot, "pnpm-workspace.yaml"), "packages: []");
  }
  if (!empty) yield* fs.writeFileString(listFile, JSON.stringify([{ path: fixtureRoot, dataDir }]));
  if (listContents !== undefined) yield* fs.writeFileString(listFile, listContents);
  let configLayer = ServerConfig.layerTest(directory, path.join(directory, "home"));
  if (descriptors !== undefined) {
    const envelopePath = path.join(directory, "bootstrap.ndjson");
    const envelope = {
      mode: "desktop" as const,
      noBrowser: true,
      port: 4888,
      t3Home: path.join(directory, "home"),
      host: "127.0.0.1",
      desktopBootstrapToken: "test-bootstrap-token",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      extensionHost: { listFile, backends: descriptors, ...(failures ? { failures } : {}) },
    };
    const encoded = yield* encodeBootstrap(envelope);
    yield* fs.writeFileString(envelopePath, encoded + "\n");
    const platform = yield* HostProcess.Platform;
    const fd = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.openSync(envelopePath, "r")),
      // Windows streams consume the original fd; POSIX streams reopen /proc or /dev/fd.
      (fd) => (platform === "win32" ? Effect.void : Effect.sync(() => NodeFS.closeSync(fd))),
    );
    const flags = {
      mode: Option.none(),
      port: Option.none(),
      host: Option.none(),
      baseDir: Option.none(),
      cwd: Option.some(directory),
      devUrl: Option.none(),
      noBrowser: Option.none(),
      bootstrapFd: Option.some(fd),
      autoBootstrapProjectFromCwd: Option.none(),
      logWebSocketEvents: Option.none(),
      tailscaleServeEnabled: Option.none(),
      tailscaleServePort: Option.none(),
    } satisfies CliServerFlags;
    const config = yield* resolveServerConfig(flags, Option.none()).pipe(
      Effect.provide(
        Layer.mergeAll(NetService.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
    );
    expect(config.extensionHost).toEqual(envelope.extensionHost);
    configLayer = ServerConfig.layer(config);
  }
  const dependencies = Layer.mergeAll(
    ExtensionHost.layer.pipe(
      Layer.provide(
        Layer.succeed(ExtensionHost.Options, dist ? { moduleUrl } : { hostRoot: directory }),
      ),
      Layer.provide(FetchHttpClient.layer),
    ),
    EnvironmentAuth.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
    ),
  ).pipe(Layer.provideMerge(configLayer), Layer.provideMerge(NodeServices.layer));
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

it.live("a headless dist module walks up to the workspace list and serves the backend", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, client, read, dataDir } = yield* harness(false, undefined, undefined, true);
      yield* host.awaitState("sample", "ready");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(dataDir, "backend.pid"))).toBe(true);
      expect(yield* (yield* client.get("/api/extensions", { headers: read })).json).toEqual({
        extensions: [{ id: "sample", backend: "ready" }],
      });
      expect(yield* (yield* client.get("/ext/sample/hello", { headers: read })).json).toEqual({
        message: "hello from sample",
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
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

it.effect("a distribution without a workspace marker never loads a list from server home", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "extension-install-" });
      const home = path.join(directory, "home");
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(
        path.join(home, "t4.extensions.json"),
        JSON.stringify([fixtureRoot]),
      );
      const services = yield* Layer.build(
        ExtensionHost.layerWithOptions({
          moduleUrl: NodeURL.pathToFileURL(path.join(directory, "install/dist/bin.mjs")),
        }).pipe(
          Layer.provide(ServerConfig.layerTest(directory, home)),
          Layer.provide(FetchHttpClient.layer),
        ),
      );
      expect(yield* Context.get(services, ExtensionHost.ExtensionHost).status).toEqual({
        extensions: [],
      });
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
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-extension-failure-",
      });
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

it.live(
  "dist bootstrap serves a ready proxy across successful and failed server scopes without stopping the owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host: owner, dataDir } = yield* harness();
        yield* owner.awaitState("sample", "ready");
        const descriptor = yield* owner.backend("sample");
        if (!descriptor) return yield* Effect.die("Missing owner descriptor");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pid = Number(yield* fs.readFileString(path.join(dataDir, "backend.pid")));
        for (const _restart of [0, 1, 2]) {
          const exit = yield* Effect.scoped(
            Effect.gen(function* () {
              const handoff =
                _restart === 0 ? descriptor : { ...descriptor, instanceId: "previous-launch" };
              const { host, client, read, config } = yield* harness(
                false,
                undefined,
                [handoff],
                true,
              );
              yield* host.awaitState("sample", "ready");
              expect(yield* host.backend("sample")).toEqual(descriptor);
              expect(yield* host.status).toEqual({
                extensions: [{ id: "sample", backend: "ready" }],
              });
              expect(yield* (yield* client.get("/api/extensions", { headers: read })).json).toEqual(
                {
                  extensions: [{ id: "sample", backend: "ready" }],
                },
              );
              const response = yield* client.get("/ext/sample/hello", { headers: read });
              expect(yield* response.json).toEqual({ message: "hello from sample" });
              expect(yield* fs.exists(path.join(config.logsDir, "extensions", "sample.log"))).toBe(
                false,
              );
              if (_restart === 1) return yield* Effect.fail("server scope failed");
            }),
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(_restart === 1);
          expect(() => process.kill(pid, 0)).not.toThrow();
          expect(Number(yield* fs.readFileString(path.join(dataDir, "backend.pid")))).toBe(pid);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "an empty desktop handoff prevents headless fallback for WSL or failed desktop launches",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, client, read, config } = yield* harness(false, undefined, []);
        yield* host.awaitState("sample", "failed");
        expect((yield* client.get("/ext/sample/hello", { headers: read })).status).toBe(503);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        expect(yield* fs.exists(path.join(config.logsDir, "extensions", "sample.log"))).toBe(false);
        expect(yield* host.backend("sample")).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports the desktop Node lookup failure through extension status", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const message = "Node.js executable not found on the desktop shell PATH.";
      const { host, client, read } = yield* harness(false, undefined, [], true, [
        { extensionId: "sample", message },
      ]);
      yield* host.awaitState("sample", "failed");
      expect(yield* (yield* client.get("/api/extensions", { headers: read })).json).toEqual({
        extensions: [{ id: "sample", backend: "failed", message }],
      });
      expect((yield* client.get("/ext/sample/hello", { headers: read })).status).toBe(503);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
