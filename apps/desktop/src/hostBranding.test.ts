// @effect-diagnostics nodeBuiltinImport:off - Native path assertions use the test platform path separator.
import "./app/DesktopEnvironment.ts";
import "./app/DesktopStatePaths.ts";
import "./app/DesktopUserData.ts";
import "./app/DesktopEarlyElectronStartup.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodePath from "node:path";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

it.effect.each([
  null,
  { appName: "T4", stageLabel: "Local", appId: "dev.example.t4", scheme: "t4", homeDirName: ".t4" },
])("resolves the real desktop identity and state paths with config %j", (config) =>
  Effect.gen(function* () {
    vi.stubGlobal("__T4_HOST_BRANDING__", config);
    vi.resetModules();
    try {
      const environmentModule = yield* Effect.promise(() => import("./app/DesktopEnvironment.ts"));
      const { resolveDesktopAppBranding } = environmentModule;
      const configModule = yield* Effect.promise(() => import("./app/DesktopConfig.ts"));
      const { resolveDesktopBaseDir } = yield* Effect.promise(
        () => import("./app/DesktopStatePaths.ts"),
      );
      const { resolveUserDataPath } = yield* Effect.promise(
        () => import("./app/DesktopUserData.ts"),
      );
      const { resolveEarlyLinuxElectronOptions } = yield* Effect.promise(
        () => import("./app/DesktopEarlyElectronStartup.ts"),
      );
      const custom = config !== null;
      const makeEnvironment = (overrides: Record<string, string>) =>
        Effect.scoped(
          environmentModule.DesktopEnvironment.pipe(
            Effect.provide(
              environmentModule
                .layer({
                  dirname: "/repo/apps/desktop/dist-electron",
                  homeDirectory: "/home/sample",
                  platform: "win32",
                  processArch: "x64",
                  appVersion: "0.1.1",
                  appPath: "/repo",
                  isPackaged: false,
                  resourcesPath: "/repo/resources",
                  runningUnderArm64Translation: false,
                })
                .pipe(
                  Layer.provide(
                    Layer.mergeAll(NodeServices.layer, configModule.layerTest(overrides)),
                  ),
                ),
            ),
          ),
        );
      const environment = yield* makeEnvironment({ VITE_DEV_SERVER_URL: "http://localhost" });
      expect(environment.appUserModelId).toBe(
        custom ? "dev.example.t4.dev" : "com.t3tools.t3code.dev",
      );
      const explicit = yield* makeEnvironment({
        T3CODE_HOME: "explicit-home",
        T3CODE_DESKTOP_APP_USER_MODEL_ID: "explicit.id",
      });
      expect(explicit.appUserModelId).toBe("explicit.id");
      expect(explicit.baseDir).toBe("explicit-home");
      for (const development of [false, true]) {
        expect(
          resolveDesktopAppBranding({ isDevelopment: development, appVersion: "0.1.1" }),
        ).toEqual({
          baseName: custom ? "T4" : "T3 Code",
          stageLabel: custom ? "Local" : development ? "Dev" : "Beta",
          displayName: custom ? "T4 (Local)" : development ? "T3 Code (Dev)" : "T3 Code (Beta)",
        });
        const early = resolveEarlyLinuxElectronOptions({
          env: development ? { VITE_DEV_SERVER_URL: "http://localhost" } : {},
          homeDirectory: "/home/sample",
          joinPath: NodePath.join,
          readFileString: () => "{}",
        });
        expect(early.linuxWmClass).toBe(
          custom
            ? `dev.example.t4${development ? ".dev" : ""}`
            : development
              ? "t3code-dev"
              : "t3code",
        );
        expect(early.linuxDesktopEntryName).toBe(
          custom
            ? `dev.example.t4${development ? ".dev" : ""}.desktop`
            : development
              ? "com.t3tools.T3Code.Development.desktop"
              : "com.t3tools.T3Code.desktop",
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const appDataDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "host-profile-" });
            const userData = yield* resolveUserDataPath({
              appDataDirectory,
              isDevelopment: development,
              platform: "win32",
            });
            expect(userData).toBe(
              NodePath.join(
                appDataDirectory,
                custom
                  ? `dev.example.t4${development ? ".dev" : ""}`
                  : development
                    ? "t3code-dev"
                    : "t3code-v2",
              ),
            );
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        );
      }
      expect(
        resolveDesktopBaseDir({
          homeDirectory: "/home/sample",
          joinPath: NodePath.join,
          t3Home: Option.none(),
        }),
      ).toBe(NodePath.join("/home/sample", custom ? ".t4" : ".t3"));
      expect(
        resolveDesktopBaseDir({
          homeDirectory: "/home/sample",
          joinPath: NodePath.join,
          t3Home: Option.some("explicit-home"),
        }),
      ).toBe("explicit-home");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }),
);
