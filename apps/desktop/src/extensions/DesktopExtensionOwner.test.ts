// @effect-diagnostics nodeBuiltinImport:off -- Fixture assertions read the PID of the child this test owns.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import * as DesktopExtensionOwner from "./DesktopExtensionOwner.ts";
import { loadExtensions } from "@t3tools/extension-sdk/node";

const fixtureRoot = NodeURL.fileURLToPath(
  new URL("../../../../packages/extension-sdk/fixtures/sample", import.meta.url),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-extension-owner-" });
  const dataDir = NodePath.join(directory, "data");
  const listFile = NodePath.join(directory, "t4.extensions.json");
  return { fs, directory, dataDir, listFile };
});

const configurationLayer = (
  directory: string,
  listFile: string,
  platform: NodeJS.Platform,
  processArch: NodeJS.Architecture,
  isPackaged = false,
) => {
  const environment = DesktopEnvironment.layer({
    dirname: NodePath.join(directory, "apps/desktop/src"),
    homeDirectory: directory,
    platform,
    processArch,
    appVersion: "1.2.3",
    appPath: directory,
    isPackaged,
    resourcesPath: directory,
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      DesktopConfig.layerTest({
        T3CODE_HOME: directory,
        ...(isPackaged ? {} : { VITE_DEV_SERVER_URL: "http://localhost:5173" }),
      }),
    ),
  );
  return DesktopBackendConfiguration.layer.pipe(
    Layer.provideMerge(DesktopShutdown.layer),
    Layer.provide(Layer.succeed(DesktopExtensionOwner.Options, { listFile })),
    Layer.provide(DesktopAppSettings.layerTest()),
    Layer.provide(DesktopWslEnvironment.layerTest()),
    Layer.provide(DesktopWslServerTree.layerTest()),
    Layer.provide(
      Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
        installIntoProcess: Effect.succeed(true),
      }),
    ),
    Layer.provide(
      Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
        getState: Effect.die("unused"),
        backendConfig: Effect.succeed({
          port: 4888,
          bindHost: "127.0.0.1",
          httpBaseUrl: new URL("http://127.0.0.1:4888"),
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        }),
        configureFromSettings: () => Effect.die("unused"),
        setMode: () => Effect.die("unused"),
        setTailscaleServeEnabled: () => Effect.die("unused"),
        getAdvertisedEndpoints: Effect.succeed([]),
      }),
    ),
    Layer.provide(environment),
  );
};

const packagedFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const root = NodePath.join(f.directory, "extensions", "sample");
  yield* f.fs.makeDirectory(NodePath.join(root, "runtime"), { recursive: true });
  yield* f.fs.makeDirectory(NodePath.join(root, "work"));
  yield* f.fs.copyFile(
    NodePath.join(fixtureRoot, "backend/server.mjs"),
    NodePath.join(root, "server.mjs"),
  );
  yield* f.fs.writeFileString(
    NodePath.join(root, "launch.mjs"),
    `import * as FS from "node:fs";
import * as Path from "node:path";
FS.writeFileSync(Path.join(process.env.T4_EXT_DATA_DIR, "backend.cwd"), process.cwd());
await import("./server.mjs");
`,
  );
  const executable = NodePath.join(root, "runtime", NodePath.basename(process.execPath));
  yield* f.fs.copyFile(process.execPath, executable);
  yield* f.fs.writeFileString(
    NodePath.join(root, "t4-extension.json"),
    JSON.stringify({
      id: "sample",
      sdk: 1,
      backend: {
        command: [`./runtime/${NodePath.basename(process.execPath)}`, "./launch.mjs"],
        cwd: "./work",
        protocol: 1,
        dataDir: f.dataDir,
      },
      routes: [{ method: "GET", path: "/**", scope: "read" }],
    }),
  );
  yield* f.fs.writeFileString(
    NodePath.join(f.directory, "extensions/index.json"),
    JSON.stringify({ version: 1, extensions: [{ id: "sample", dir: "sample" }] }),
  );
  return { ...f, root };
});

it.live(
  "packaged desktop hands ready backends and loadable routes to server restarts and stops on quit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, directory, dataDir, listFile, root } = yield* packagedFixture;
        // A packaged app must ignore even a valid development list.
        yield* fs.writeFileString(listFile, "[]");
        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const shutdown = yield* DesktopShutdown.DesktopShutdown;
          const first = yield* configuration.resolvePrimary;
          const host = first.bootstrap.extensionHost;
          const descriptor = host?.backends[0];
          expect(descriptor).toBeDefined();
          if (!descriptor || !host?.listFile) return yield* Effect.die("Missing packaged handoff");
          expect(descriptor.dataDir).toBe(dataDir);
          expect(
            loadExtensions(directory, host.listFile).map((extension) => ({
              root: extension.root,
              routes: extension.manifest.routes,
            })),
          ).toEqual([{ root, routes: [{ method: "GET", path: "/**", scope: "read" }] }]);
          const pid = Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")));
          expect(yield* fs.readFileString(NodePath.join(dataDir, "backend.cwd"))).toBe(
            NodePath.join(root, "work"),
          );
          expect((yield* configuration.resolvePrimary).bootstrap.extensionHost).toEqual(host);
          expect(Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")))).toBe(pid);
          const client = yield* HttpClient.HttpClient;
          expect(
            yield* (yield* client.get(descriptor.url + "/hello", {
              headers: { authorization: "Bearer " + descriptor.token },
            })).json,
          ).toEqual({ message: "hello from sample" });
          yield* shutdown.request;
          yield* shutdown.markComplete;
          expect(() => process.kill(pid, 0)).toThrow();
        }).pipe(
          Effect.provide(
            configurationLayer(
              directory,
              listFile,
              yield* HostProcess.Platform,
              yield* HostProcess.Architecture,
              true,
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

it.live(
  "packaged backends restart and suspend for updates using the data-dir override without PATH Node",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, directory, dataDir } = yield* packagedFixture;
        const override = NodePath.join(directory, "override-data");
        const owner = yield* DesktopExtensionOwner.make({
          hostRoot: directory,
          resourcesPath: directory,
          enabled: true,
          platform: yield* HostProcess.Platform,
          stateDir: directory,
          logsDir: directory,
          environment: { ...process.env, T4_EXT_DATA_DIR__SAMPLE: override },
        }).pipe(
          Effect.provideService(SpawnExecutableResolution, () => {
            throw new Error("Packaged runtime must not resolve PATH Node");
          }),
        );
        const bootstrap = yield* owner.bootstrap;
        const first = bootstrap.extensionHost?.backends[0];
        if (!first) return yield* Effect.die("Missing packaged descriptor");
        expect(first.dataDir).toBe(override);
        expect(loadExtensions(directory, bootstrap.extensionHost!.listFile)[0]?.dataDir).toBe(
          override,
        );
        expect(yield* fs.exists(dataDir)).toBe(false);
        const firstPid = Number(yield* fs.readFileString(NodePath.join(override, "backend.pid")));
        const restarting = yield* owner.awaitState("sample", "restarting").pipe(Effect.forkScoped);
        const client = yield* HttpClient.HttpClient;
        yield* client
          .post(first.url + "/crash", { headers: { authorization: "Bearer " + first.token } })
          .pipe(Effect.flatMap((response) => response.text));
        yield* Fiber.join(restarting);
        yield* owner.awaitState("sample", "ready");
        const second = (yield* owner.bootstrap).extensionHost?.backends[0];
        expect(second?.url).toBe(first.url);
        expect(second?.token).toBe(first.token);
        expect(second?.instanceId).not.toBe(first.instanceId);
        expect(() => process.kill(firstPid, 0)).toThrow();
        const secondPid = Number(yield* fs.readFileString(NodePath.join(override, "backend.pid")));
        yield* owner.suspend;
        expect(() => process.kill(secondPid, 0)).toThrow();
        yield* owner.resume;
        const thirdPid = Number(yield* fs.readFileString(NodePath.join(override, "backend.pid")));
        expect(thirdPid).not.toBe(secondPid);
        yield* owner.stop;
        expect(() => process.kill(thirdPid, 0)).toThrow();
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

it.effect(
  "missing and invalid packaged indexes start without extensions or a development fallback",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, directory, listFile } = yield* fixture;
        yield* fs.writeFileString(listFile, JSON.stringify([fixtureRoot]));
        yield* fs.makeDirectory(NodePath.join(directory, "extensions"));
        for (const contents of [undefined, "{", JSON.stringify({ version: 2, extensions: [] })]) {
          if (contents !== undefined)
            yield* fs.writeFileString(NodePath.join(directory, "extensions/index.json"), contents);
          yield* Effect.gen(function* () {
            const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
            const host = (yield* configuration.resolvePrimary).bootstrap.extensionHost;
            expect(host?.backends).toEqual([]);
            if (host?.listFile) expect(loadExtensions(directory, host.listFile)).toEqual([]);
          }).pipe(
            Effect.provide(
              configurationLayer(
                directory,
                listFile,
                yield* HostProcess.Platform,
                yield* HostProcess.Architecture,
                true,
              ),
            ),
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("one desktop owner survives server config restarts and stops before quit completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, directory, dataDir, listFile } = yield* fixture;
      yield* fs.writeFileString(listFile, JSON.stringify([{ path: fixtureRoot, dataDir }]));
      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        const [first, concurrent] = yield* Effect.all(
          [configuration.resolvePrimary, configuration.resolvePrimary],
          { concurrency: "unbounded" },
        );
        const descriptor = first.bootstrap.extensionHost?.backends[0];
        expect(first.bootstrap.extensionHost?.listFile).toBe(listFile);
        expect(descriptor).toBeDefined();
        if (!descriptor) return yield* Effect.die("Missing fixture descriptor");
        expect(concurrent.bootstrap.extensionHost).toEqual(first.bootstrap.extensionHost);
        const pid = Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")));
        expect(() => process.kill(pid, 0)).not.toThrow();
        const second = yield* configuration.resolvePrimary;
        expect(second.bootstrap.extensionHost).toEqual(first.bootstrap.extensionHost);
        expect(Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")))).toBe(pid);
        const client = yield* HttpClient.HttpClient;
        const hello = yield* client.get(descriptor.url + "/hello", {
          headers: { authorization: "Bearer " + descriptor.token },
        });
        expect(yield* hello.json).toEqual({ message: "hello from sample" });
        yield* shutdown.request;
        yield* shutdown.markComplete;
        expect(yield* shutdown.isComplete).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
      }).pipe(
        Effect.provide(
          configurationLayer(
            directory,
            listFile,
            yield* HostProcess.Platform,
            yield* HostProcess.Architecture,
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

it.effect("a missing list keeps bootstrap unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { directory, listFile } = yield* fixture;
      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        expect(Object.hasOwn(config.bootstrap, "extensionHost")).toBe(false);
      }).pipe(
        Effect.provide(
          configurationLayer(
            directory,
            listFile,
            yield* HostProcess.Platform,
            yield* HostProcess.Architecture,
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "update suspension stops the captured child once and recovery creates a working owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, directory, dataDir, listFile } = yield* fixture;
        yield* fs.writeFileString(listFile, JSON.stringify([{ path: fixtureRoot, dataDir }]));
        const owner = yield* DesktopExtensionOwner.make({
          hostRoot: directory,
          platform: yield* HostProcess.Platform,
          enabled: true,
          stateDir: directory,
          logsDir: directory,
        });
        yield* owner.bootstrap;
        const firstPid = Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")));
        yield* owner.suspend;
        yield* owner.suspend;
        expect(() => process.kill(firstPid, 0)).toThrow();
        yield* owner.resume;
        yield* owner.resume;
        const descriptor = (yield* owner.bootstrap).extensionHost?.backends[0];
        if (!descriptor) return yield* Effect.die("Missing recovered fixture descriptor");
        const secondPid = Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")));
        expect(secondPid).not.toBe(firstPid);
        const client = yield* HttpClient.HttpClient;
        expect(
          yield* (yield* client.get(descriptor.url + "/hello", {
            headers: { authorization: "Bearer " + descriptor.token },
          })).json,
        ).toEqual({ message: "hello from sample" });
        yield* owner.suspend;
        yield* owner.stop;
        yield* owner.resume;
        expect(() => process.kill(secondPid, 0)).toThrow();
        expect(Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")))).toBe(
          secondPid,
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

it.live(
  "authenticated owner restart preserves proxy URL and bearer and rotates launch identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, directory, dataDir, listFile } = yield* fixture;
        yield* fs.writeFileString(listFile, JSON.stringify([{ path: fixtureRoot, dataDir }]));
        const owner = yield* DesktopExtensionOwner.make({
          hostRoot: directory,
          platform: yield* HostProcess.Platform,
          enabled: true,
          stateDir: directory,
          logsDir: directory,
        });
        const bootstrap = yield* owner.bootstrap;
        const first = bootstrap.extensionHost?.backends[0];
        const control = bootstrap.extensionHost?.control;
        if (!first || !control) return yield* Effect.die("Missing fixture descriptor");
        const firstPid = Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")));
        const restarting = yield* owner.awaitState("sample", "restarting").pipe(Effect.forkScoped);
        const client = yield* HttpClient.HttpClient;
        expect((yield* client.post(control.url + "/restart/sample")).status).toBe(401);
        expect(
          (yield* client.post(control.url + "/restart/sample", {
            headers: { authorization: "Bearer " + control.token },
          })).status,
        ).toBe(202);
        yield* Fiber.join(restarting);
        yield* owner.awaitState("sample", "ready");
        const second = (yield* owner.bootstrap).extensionHost?.backends[0];
        expect(second?.url).toBe(first.url);
        expect(second?.token).toBe(first.token);
        expect(second?.instanceId).not.toBe(first.instanceId);
        const secondPid = Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")));
        expect(secondPid).not.toBe(firstPid);
        expect(() => process.kill(firstPid, 0)).toThrow();
        yield* owner.stop;
        expect(() => process.kill(secondPid, 0)).toThrow();
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

it.effect("WSL bootstrap explicitly disables headless Windows manifest launches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { directory, listFile } = yield* fixture;
      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5000, distro: null });
        expect(config.bootstrap.extensionHost).toEqual({ backends: [] });
        expect(Option.isSome(config.preflightFailure)).toBe(true);
      }).pipe(
        Effect.provide(
          configurationLayer(
            directory,
            listFile,
            yield* HostProcess.Platform,
            yield* HostProcess.Architecture,
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("resolves node through the prepared shell PATH instead of the Electron executable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, directory, dataDir, listFile } = yield* fixture;
      yield* fs.writeFileString(listFile, JSON.stringify([{ path: fixtureRoot, dataDir }]));
      const environment = {
        ...process.env,
        PATH: "prepared-shell-path",
        T4_EXT_DATA_DIR__SAMPLE: NodePath.join(directory, "ignored-packaged-override"),
      };
      const platform = yield* HostProcess.Platform;
      const lookups: unknown[] = [];
      const owner = yield* DesktopExtensionOwner.make({
        hostRoot: directory,
        platform,
        enabled: true,
        stateDir: directory,
        logsDir: directory,
        environment,
      }).pipe(
        Effect.provideService(SpawnExecutableResolution, (command, hostPlatform, env) => {
          lookups.push({ command, platform: hostPlatform, path: env.PATH });
          return process.execPath;
        }),
      );
      const descriptor = (yield* owner.bootstrap).extensionHost?.backends[0];
      expect(lookups).toEqual([
        {
          command: platform === "win32" ? "node.exe" : "node",
          platform,
          path: "prepared-shell-path",
        },
      ]);
      if (!descriptor) return yield* Effect.die("Missing Node fixture descriptor");
      expect(descriptor.dataDir).toBe(dataDir);
      const client = yield* HttpClient.HttpClient;
      expect(
        yield* (yield* client.get(descriptor.url + "/hello", {
          headers: { authorization: "Bearer " + descriptor.token },
        })).json,
      ).toEqual({ message: "hello from sample" });
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

it.effect("missing Node fails clearly without spawning or handing ownership to the server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, directory, dataDir, listFile } = yield* fixture;
      yield* fs.writeFileString(listFile, JSON.stringify([{ path: fixtureRoot, dataDir }]));
      const owner = yield* DesktopExtensionOwner.make({
        hostRoot: directory,
        platform: yield* HostProcess.Platform,
        enabled: true,
        stateDir: directory,
        logsDir: directory,
      }).pipe(Effect.provideService(SpawnExecutableResolution, () => undefined));
      const bootstrap = yield* owner.bootstrap;
      expect(bootstrap.extensionHost).toMatchObject({
        listFile,
        backends: [],
        failures: [
          {
            extensionId: "sample",
            message: "Node.js executable not found on the desktop shell PATH.",
          },
        ],
      });
      yield* owner.awaitState("sample", "failed");
      expect(yield* fs.exists(NodePath.join(dataDir, "backend.pid"))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
