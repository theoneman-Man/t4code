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
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient } from "effect/http";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as ExtensionUpdates from "./updates.ts";

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
  const mutex = yield* Semaphore.make(1);
  let ownerScope = yield* Scope.make();
  let closed = false;
  const stop = mutex.withPermits(1)(
    Effect.gen(function* () {
      closed = true;
      yield* Scope.close(ownerScope, Exit.void);
    }),
  );
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
  let initialized = yield* Deferred.make<void>();
  let started = false;
  let suspended = false;
  const start = Effect.gen(function* () {
    if (closed) return;
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
  }).pipe(mutex.withPermits(1));
  const suspend = mutex.withPermits(1)(
    Effect.gen(function* () {
      if (closed || suspended || !started) return;
      suspended = true;
      yield* Scope.close(ownerScope, Exit.void);
      ownerScope = yield* Scope.make();
      initialized = yield* Deferred.make<void>();
      started = false;
      for (const entry of entries) {
        entry.descriptor = undefined;
        entry.message = undefined;
        entry.state = "stopped";
        for (const listener of entry.listeners) listener(entry.state);
      }
    }),
  );
  const resume = Effect.suspend(() =>
    suspended && !closed
      ? start.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              suspended = false;
            }),
          ),
        )
      : Effect.void,
  );
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
  return { bootstrap, stop, awaitState, suspend, resume };
});

// WSL cannot execute Windows manifests or reach Windows loopback backends in every network mode.
// An explicit empty handoff disables headless ownership in that server too.
export const wslBootstrap = { extensionHost: { backends: [] } } as const;

export const makeForDesktop = Effect.fn("DesktopExtensionOwner.makeForDesktop")(function* (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
) {
  const options = yield* Options;
  const owner = yield* make({
    hostRoot: environment.rootDir,
    platform: environment.platform,
    ...options,
    // Packaged list/root selection is supplied by the packaging integration.
    enabled: environment.isDevelopment,
    stateDir: environment.stateDir,
    logsDir: environment.logDir,
    // The shell environment is prepared before the first bootstrap starts extensions.
    environment: process.env,
  });
  const shutdown = yield* Effect.serviceOption(DesktopShutdown.DesktopShutdown);
  if (Option.isSome(shutdown)) {
    yield* shutdown.value.registerExtensionStop?.(owner.stop) ?? Effect.void;
    yield* ExtensionUpdates.register(shutdown.value, owner);
  }
  return owner;
});
