import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/http";
import { launch, type ReadyBackendDescriptor } from "./process.ts";

it("development reload gracefully exits before relaunch, repeats readiness and preserves the endpoint", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "extension-reload-"));
  const data = NodePath.join(root, "data"),
    source = NodePath.join(root, "source.ts");
  // oxlint-disable-next-line t3code/no-global-process-runtime -- SDK subprocess tests have no dependency on app platform services.
  const platform = NodeOS.platform();
  await NodeFSP.writeFile(source, "before");
  const descriptors: ReadyBackendDescriptor[] = [];
  try {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- SDK subprocess tests do not depend on an app runtime.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const reloaded = yield* Deferred.make<void>();
          yield* launch(
            {
              root,
              dataDir: data,
              manifest: {
                id: "reload-fixture",
                sdk: 1,
                routes: [],
                backend: {
                  command: [
                    process.execPath,
                    NodeURL.fileURLToPath(new URL("./fixtures/stop-backend.mjs", import.meta.url)),
                    "graceful",
                  ],
                  cwd: ".",
                  protocol: 1,
                },
              },
            },
            Effect.void,
            { platform, stateDir: data, logsDir: data, development: true },
            (descriptor) =>
              Effect.gen(function* () {
                descriptors.push(descriptor);
                if (descriptors.length === 1)
                  yield* Effect.promise(() => NodeFSP.writeFile(source, "after"));
                else {
                  expect(
                    yield* Effect.promise(() =>
                      NodeFSP.readFile(NodePath.join(data, "finalized"), "utf8"),
                    ),
                  ).toBe("stopped");
                  yield* Deferred.succeed(reloaded, undefined);
                }
              }),
          ).pipe(Effect.forkIn(scope));
          yield* Deferred.await(reloaded);
          yield* Scope.close(scope, Exit.void);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]!.url).toBe(descriptors[1]!.url);
    expect(descriptors[0]!.token).toBe(descriptors[1]!.token);
    expect(descriptors[0]!.instanceId).not.toBe(descriptors[1]!.instanceId);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
