import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/http";
import { backendEnvironment, launch, type ReadyBackendDescriptor } from "./process.ts";

async function stoppedFixture(mode: string, check: (directory: string) => Promise<void>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "extension-stop-"));
  try {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The SDK declares only vite-plus/test; keep its real-process test independent of app test dependencies.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const ready = yield* Deferred.make<ReadyBackendDescriptor>();
          yield* launch(
            {
              root: directory,
              dataDir: directory,
              manifest: {
                id: "sample",
                sdk: 1,
                routes: [],
                backend: {
                  command: [
                    process.execPath,
                    NodeURL.fileURLToPath(new URL("./fixtures/stop-backend.mjs", import.meta.url)),
                    mode,
                  ],
                  protocol: 1,
                  cwd: ".",
                },
              },
            },
            Effect.void,
            {
              // oxlint-disable-next-line t3code/no-global-process-runtime -- The SDK Node boundary has no dependency on the host application's platform service.
              platform: NodeOS.platform(),
              stateDir: directory,
              logsDir: directory,
            },
            (value) => Deferred.succeed(ready, value).pipe(Effect.asVoid),
          ).pipe(Effect.forkIn(scope));
          yield* Deferred.await(ready);
          yield* Scope.close(scope, Exit.void);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    await check(directory);
    const pid = Number(await NodeFSP.readFile(NodePath.join(directory, "backend.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

it("scope shutdown lets an authenticated backend finalize and exit before killing it", () =>
  stoppedFixture("graceful", async (directory) => {
    expect(await NodeFSP.readFile(NodePath.join(directory, "finalized"), "utf8")).toBe("stopped");
    expect(await NodeFSP.readFile(NodePath.join(directory, "exit-code"), "utf8")).toBe("0");
  }));

it.each(["unsupported", "disconnect", "stall-response", "stall-exit"])(
  "scope shutdown falls back to process termination for %s backends",
  (mode) =>
    stoppedFixture(mode, async (directory) => {
      expect(await NodeFSP.readFile(NodePath.join(directory, "shutdown-requested"), "utf8")).toBe(
        "POST",
      );
    }),
);

it("launches with only the extension bearer and strips inherited host credentials", () => {
  const environment = backendEnvironment(
    {
      PATH: "bin",
      T3CODE_DEV_AUTH_TOKEN: "host",
      T4_TOKEN: "host",
      T4_EXT_TOKEN: "old",
      ELECTRON_RUN_AS_NODE: "1",
    },
    {
      extensionId: "sample",
      url: "http://127.0.0.1:1234",
      token: "launch",
      instanceId: "instance",
      dataDir: "/data",
    },
  );
  expect(environment).toMatchObject({
    PATH: "bin",
    T4_EXT_ID: "sample",
    T4_EXT_PORT: "1234",
    T4_EXT_TOKEN: "launch",
    T4_EXT_INSTANCE: "instance",
    T4_EXT_DATA_DIR: "/data",
  });
  expect(environment).not.toHaveProperty("T3CODE_DEV_AUTH_TOKEN");
  expect(environment).not.toHaveProperty("T4_TOKEN");
  expect(environment).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
});
