// @effect-diagnostics nodeBuiltinImport:off -- Desktop startup discovers Node-only extension manifests.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { EXTENSION_LIST_FILE } from "@t3tools/extension-sdk/manifest";
import { loadExtensions, type ResolvedExtension } from "@t3tools/extension-sdk/node";
import * as BackendSupervisor from "@t3tools/extension-sdk/host";
import type { ReadyBackendDescriptor, ProcessOptions } from "@t3tools/extension-sdk/host";
import type { ExtensionBackendState } from "@t3tools/extension-sdk/protocol";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/http";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

export interface OwnerOptions extends Omit<ProcessOptions, "executable"> {
  readonly hostRoot: string;
  readonly listFile?: string;
  readonly enabled: boolean;
}

/** Tests provide a temp list without reading the developer's repo configuration. */
export class Options extends Context.Reference<{ readonly listFile?: string }>(
  "desktop/extensions/Options",
  { defaultValue: () => ({}) },
) {}

export const make = Effect.fn("DesktopExtensionOwner.make")(function* (options: OwnerOptions) {
  const resolveExecutable = yield* SpawnExecutableResolution;
  const ownerScope = yield* Scope.make();
  const stop = Scope.close(ownerScope, Exit.void);
  yield* Effect.addFinalizer(() => stop);
  const listFile = NodePath.resolve(options.hostRoot, options.listFile ?? EXTENSION_LIST_FILE);
  const hasList = options.enabled && NodeFS.existsSync(listFile);
  let extensions: ResolvedExtension[] = [];
  if (hasList) {
    extensions = yield* Effect.try(() => loadExtensions(options.hostRoot, listFile)).pipe(
      Effect.catch(() =>
        Effect.logError("Extensions disabled: invalid desktop extension configuration.").pipe(
          Effect.as([]),
        ),
      ),
    );
  }
  const entries = extensions
    .filter((extension) => extension.manifest.backend)
    .map((extension) => ({
      extension,
      descriptor: undefined as ReadyBackendDescriptor | undefined,
      state: "starting" as ExtensionBackendState,
      message: undefined as string | undefined,
      listeners: new Set<(state: ExtensionBackendState) => void>(),
    }));
  const initialized = yield* Deferred.make<void>();
  let started = false;
  const start = Effect.gen(function* () {
    // Config resolution can race with another server start. Claim ownership before yielding.
    if (started) return yield* Deferred.await(initialized);
    started = true;
    yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const environment = options.environment ?? process.env;
          const executable =
            entry.extension.manifest.backend!.command[0] === "node"
              ? resolveExecutable(
                  options.platform === "win32" ? "node.exe" : "node",
                  options.platform,
                  environment,
                )
              : undefined;
          if (entry.extension.manifest.backend!.command[0] === "node" && !executable) {
            entry.state = "failed";
            entry.message = "Node.js executable not found on the desktop shell PATH.";
            for (const listener of entry.listeners) listener(entry.state);
            return Effect.void;
          }
          const endpoint = yield* BackendSupervisor.allocateEndpoint();
          const firstAttempt = yield* Deferred.make<void>();
          const setState = (state: ExtensionBackendState, message?: string) =>
            Effect.sync(() => {
              entry.state = state;
              entry.message = message;
              for (const listener of entry.listeners) listener(state);
            });
          const supervisor = BackendSupervisor.supervise(
            (ready) =>
              BackendSupervisor.launch(
                entry.extension,
                ready,
                {
                  ...options,
                  ...(executable ? { executable } : {}),
                  environment,
                  onStarting: (descriptor) =>
                    Effect.sync(() => {
                      entry.descriptor = descriptor;
                    }),
                },
                (descriptor) =>
                  Effect.gen(function* () {
                    entry.descriptor = descriptor;
                    yield* setState("ready");
                    yield* Deferred.succeed(firstAttempt, undefined);
                  }),
                endpoint,
              ),
            (state, message) =>
              setState(state, message).pipe(
                Effect.andThen(Deferred.succeed(firstAttempt, undefined)),
                Effect.asVoid,
              ),
          ).pipe(Effect.provide(FetchHttpClient.layer));
          yield* supervisor.pipe(Effect.forkIn(ownerScope));
          return Deferred.await(firstAttempt);
        }).pipe(
          Effect.catch(() =>
            Effect.logError("Desktop extension endpoint allocation failed.").pipe(
              Effect.as(Effect.void),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.flatMap((attempts) =>
        Effect.all(attempts, { concurrency: "unbounded", discard: true }),
      ),
      Effect.ensuring(Deferred.succeed(initialized, undefined)),
    );
  });
  const bootstrap = Effect.gen(function* () {
    yield* start;
    // Presence means desktop ownership, even if all launches failed. No server may fall back.
    return hasList
      ? {
          extensionHost: {
            listFile,
            backends: entries.flatMap((entry) => (entry.descriptor ? [entry.descriptor] : [])),
            ...(entries.some((entry) => entry.state === "failed" && entry.message)
              ? {
                  failures: entries.flatMap((entry) =>
                    entry.state === "failed" && entry.message
                      ? [
                          {
                            extensionId: entry.extension.manifest.id,
                            message: entry.message,
                          },
                        ]
                      : [],
                  ),
                }
              : {}),
          },
        }
      : {};
  });
  const awaitState = Effect.fn("DesktopExtensionOwner.awaitState")(
    (id: string, state: ExtensionBackendState) =>
      Effect.callback<void>((resume) => {
        const entry = entries.find((item) => item.extension.manifest.id === id);
        if (!entry) return resume(Effect.die("Unknown desktop extension"));
        const listener = (current: ExtensionBackendState) => {
          if (current === state) resume(Effect.void);
        };
        entry.listeners.add(listener);
        listener(entry.state);
        return Effect.sync(() => {
          entry.listeners.delete(listener);
        });
      }),
  );
  return { bootstrap, stop, awaitState };
});

// WSL cannot execute Windows manifests or reach Windows loopback backends in every network mode.
// An explicit empty handoff disables headless ownership in that server too.
export const wslBootstrap = { extensionHost: { backends: [] } } as const;
