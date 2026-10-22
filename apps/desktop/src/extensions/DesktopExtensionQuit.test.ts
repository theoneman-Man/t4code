// @effect-diagnostics nodeBuiltinImport:off -- Tests read only captured fixture PIDs.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { FetchHttpClient } from "effect/http";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopExtensionOwner from "./DesktopExtensionOwner.ts";
function layerElectronApp(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

function layerElectronWindow(destroyAll: Effect.Effect<void> = Effect.void) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function layerDesktopWindow(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.void,
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: () => Effect.void,
    runMainContentsCommand: () => Effect.void,
    syncAppearance: Effect.void,
  });
}

it.live.each(["window-all-closed", "before-quit", "SIGINT", "SIGTERM"] as const)(
  "%s waits for the extension process to stop before quitting",
  (path) =>
    Effect.scoped(
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const signals = new Map<string, () => void>();
        const originalOn = process.on.bind(process);
        using _signals = vi.spyOn(process, "on").mockImplementation((name, listener) => {
          if (name === "SIGINT" || name === "SIGTERM") {
            signals.set(name, listener);
            return process;
          }
          return originalOn(name, listener);
        });
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "extension-quit-" });
        const dataDir = NodePath.join(directory, "data");
        const listFile = NodePath.join(directory, "t4.extensions.json");
        const fixtureRoot = NodeURL.fileURLToPath(
          new URL("../../../../packages/extension-sdk/fixtures/sample", import.meta.url),
        );
        yield* fs.writeFileString(listFile, JSON.stringify([{ path: fixtureRoot, dataDir }]));
        const owner = yield* DesktopExtensionOwner.make({
          hostRoot: directory,
          listFile,
          enabled: true,
          platform: yield* HostProcess.Platform,
          stateDir: directory,
          logsDir: directory,
        });
        yield* owner.bootstrap;
        const pid = Number(yield* fs.readFileString(NodePath.join(dataDir, "backend.pid")));
        const finished = yield* Deferred.make<void>();
        const quit = Effect.gen(function* () {
          let prevented = false;
          appListeners.get("before-quit")?.({
            preventDefault: () => {
              prevented = true;
            },
          });
          if (!prevented) {
            expect(() => process.kill(pid, 0)).toThrow();
            yield* Deferred.succeed(finished, undefined);
          }
        });
        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(layerElectronApp(appListeners, quit)),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(layerElectronWindow()),
          Layer.provideMerge(layerDesktopWindow()),
          Layer.provideMerge(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              platform: path.startsWith("SIG") ? "linux" : "win32",
              isDevelopment: false,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
          ),
          Layer.provideMerge(DesktopShutdown.layer),
          Layer.provideMerge(DesktopState.layer),
        );
        yield* Effect.gen(function* () {
          const shutdown = yield* DesktopShutdown.DesktopShutdown;
          yield* (
            shutdown.registerExtensionStop?.(owner.stop) ??
              Effect.die("Missing extension shutdown registration")
          );
          const worker = yield* shutdown.awaitRequest.pipe(
            Effect.andThen(shutdown.markComplete),
            Effect.forkScoped,
          );
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;
          if (path.startsWith("SIG")) signals.get(path)?.();
          else if (path === "window-all-closed") appListeners.get(path)?.();
          else appListeners.get(path)?.({ preventDefault: () => {} });
          yield* Deferred.await(finished);
          yield* Fiber.join(worker);
          expect(yield* shutdown.isComplete).toBe(true);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);
