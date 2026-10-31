// @effect-diagnostics nodeBuiltinImport:off -- Resolve the optional Node host list at startup.
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { EXTENSION_LIST_FILE } from "@t3tools/extension-sdk/manifest";
import { loadExtensions, type ResolvedExtension } from "@t3tools/extension-sdk/node";
import * as BackendSupervisor from "@t3tools/extension-sdk/host";
import type { ReadyBackendDescriptor } from "@t3tools/extension-sdk/host";
import type {
  ExtensionBackendState,
  ExtensionStatus,
  ExtensionStatusResponse,
  ExtensionBackendLifecycle,
} from "@t3tools/extension-sdk/protocol";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import { routeScope } from "./proxy.ts";

export interface HostOptions {
  /** Packaged hosts may supply an explicit root/list. */
  readonly hostRoot?: string;
  readonly moduleUrl?: URL;
  readonly listFile?: string;
  readonly descriptors?: readonly ReadyBackendDescriptor[];
}

/** Route-graph tests override this reference without changing the production source root. */
export class Options extends Context.Reference<HostOptions>("t3/extensions/Options", {
  defaultValue: () => ({}),
}) {}

class ExtensionHostError extends Schema.TaggedError<ExtensionHostError>()("ExtensionHostError", {
  stage: Schema.Literals(["load", "launch", "identity"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Extension backend operation failed.";
  }
}

export class ExtensionHost extends Context.Service<
  ExtensionHost,
  {
    readonly status: Effect.Effect<ExtensionStatusResponse>;
    readonly threadHostUrl: string;
    readonly hasThreadPermission: (id: string) => Effect.Effect<boolean>;
    readonly resolveRoute: (
      method: string,
      rawUrl: string,
    ) => Effect.Effect<ReturnType<typeof routeScope>>;
    readonly backend: (id: string) => Effect.Effect<ReadyBackendDescriptor | undefined>;
    readonly lifecycle: (id: string) => Effect.Effect<ExtensionBackendLifecycle | undefined>;
    readonly restart: (
      id: string,
    ) => Effect.Effect<ExtensionBackendLifecycle | undefined, ExtensionHostError>;
    readonly awaitState: (
      id: string,
      state: ExtensionBackendState,
    ) => Effect.Effect<ExtensionStatus>;
  }
>()("t3/extensions/ExtensionHost") {}

const resolveHostRoot = (moduleUrl: URL) => {
  const moduleDirectory = NodePath.dirname(NodeURL.fileURLToPath(moduleUrl));
  let directory = moduleDirectory;
  while (true) {
    if (NodeFS.existsSync(NodePath.join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = NodePath.dirname(directory);
    if (parent === directory) return moduleDirectory;
    directory = parent;
  }
};

const loadFailureReason = (cause: unknown) => {
  // Loader errors can contain JSON excerpts or manifest values. Log only fixed categories.
  const message = cause instanceof Error ? cause.message : "";
  if (/JSON|position \d+|Unexpected|Unterminated|Expected property/.test(message))
    return "Invalid JSON in extension configuration.";
  if (/ENOENT|does not exist/.test(message)) return "An extension manifest is missing.";
  if (/EACCES|EPERM/.test(message))
    return "Extension configuration is not readable: permission denied.";
  if (/EISDIR/.test(message)) return "Extension configuration must be a file.";
  return "Extension list or manifest validation failed.";
};
const make = Effect.fn("ExtensionHost.make")(function* (options: HostOptions) {
  const config = yield* ServerConfig.ServerConfig;
  const clock = yield* Clock.Clock;
  const client = yield* HttpClient.HttpClient;
  const callbackHost =
    config.host === undefined || config.host === "0.0.0.0"
      ? "127.0.0.1"
      : config.host === "::"
        ? "[::1]"
        : config.host.includes(":")
          ? `[${config.host}]`
          : config.host;
  const inherited = yield* HostProcess.Environment;
  const executable = yield* HostProcess.ExecutablePath;
  const platform = yield* HostProcess.Platform;
  const hostRoot =
    options.hostRoot ?? resolveHostRoot(options.moduleUrl ?? new URL(import.meta.url));
  const listFile =
    options.listFile ??
    config.extensionHost?.listFile ??
    NodePath.join(hostRoot, EXTENSION_LIST_FILE);
  const descriptors = options.descriptors ?? config.extensionHost?.backends;
  const extensions = yield* Effect.try({
    try: () => loadExtensions(hostRoot, listFile),
    catch: (cause) => new ExtensionHostError({ stage: "load", cause }),
  }).pipe(
    Effect.catchTags({
      ExtensionHostError: (error) =>
        Effect.logError("Extensions disabled: failed to load extension configuration.", {
          path: listFile,
          reason: loadFailureReason(error.cause),
        }).pipe(Effect.as([] as ResolvedExtension[])),
    }),
  );
  const entries = new Map(
    extensions.map((extension) => [
      extension.manifest.id,
      {
        extension,
        status: {
          id: extension.manifest.id,
          backend: extension.manifest.backend ? "starting" : "none",
          ...(extension.manifest.backend
            ? { lifecycle: { state: "starting", since: clock.currentTimeMillisUnsafe() } }
            : {}),
        } as ExtensionStatus,
        descriptor: undefined as ReadyBackendDescriptor | undefined,
        listeners: new Set<(status: ExtensionStatus) => void>(),
        restart: BackendSupervisor.createRestartSignal(),
      },
    ]),
  );
  const setState = Effect.fn("ExtensionHost.setState")(
    (
      id: string,
      backend: ExtensionBackendState,
      descriptor?: ReadyBackendDescriptor,
      message?: string,
      lifecycle?: ExtensionBackendLifecycle,
    ) =>
      Effect.sync(() => {
        const entry = entries.get(id)!;
        const state = backend === "failed" || backend === "stopped" ? "down" : backend;
        const previous = entry.status.lifecycle;
        const lastError =
          message &&
          (((state === "down" || state === "restarting") && message !== "Restart requested.") ||
            message.startsWith("reload failed:"))
            ? message
            : state === "ready"
              ? undefined
              : previous?.lastError;
        entry.status = {
          id,
          backend,
          ...(message ? { message } : {}),
          lifecycle: lifecycle ?? {
            state,
            since: previous?.state === state ? previous.since : clock.currentTimeMillisUnsafe(),
            ...(message ? { reason: message } : {}),
            ...(lastError ? { lastError } : {}),
            attempt: previous?.attempt ?? 0,
          },
        };
        entry.descriptor = descriptor;
        for (const listener of entry.listeners) listener(entry.status);
      }),
  );

  const control = config.extensionHost?.control;
  const loopbackOrigin = (raw: string) => {
    const url = URL.parse(raw);
    return url &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : undefined;
  };
  const controlOrigin = control && loopbackOrigin(control.url);
  const ownerSnapshotSchema = Schema.Struct({
    id: Schema.String,
    lifecycle: Schema.Struct({
      state: Schema.Literals(["starting", "ready", "reloading", "restarting", "down"]),
      reason: Schema.optionalKey(Schema.String),
      lastError: Schema.optionalKey(Schema.String),
      since: Schema.Number,
      attempt: Schema.optionalKey(Schema.Number),
    }),
    descriptor: Schema.optionalKey(
      Schema.Struct({
        extensionId: Schema.String,
        url: Schema.String,
        token: Schema.String,
        instanceId: Schema.String,
        dataDir: Schema.String,
      }),
    ),
  });
  if (control && controlOrigin) {
    yield* Effect.scoped(
      HttpClient.withScope(client)
        .get(`${controlOrigin}/states`, {
          headers: { authorization: `Bearer ${control.token}` },
        })
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) =>
            response.stream.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.filter((line) => line.length > 0),
              Stream.runForEach((line) =>
                Schema.decodeUnknownEffect(Schema.fromJsonString(ownerSnapshotSchema))(line).pipe(
                  Effect.flatMap((snapshot) => {
                    const entry = entries.get(snapshot.id);
                    if (!entry?.extension.manifest.backend) return Effect.void;
                    const descriptor = snapshot.descriptor;
                    if (
                      descriptor &&
                      (descriptor.extensionId !== snapshot.id || !loopbackOrigin(descriptor.url))
                    )
                      return Effect.void;
                    return setState(
                      snapshot.id,
                      snapshot.lifecycle.state,
                      snapshot.lifecycle.state === "ready" ? descriptor : undefined,
                      snapshot.lifecycle.reason,
                      snapshot.lifecycle,
                    );
                  }),
                ),
              ),
            ),
          ),
          Effect.andThen(
            Effect.fail(new ExtensionHostError({ stage: "identity", cause: "Owner stream ended" })),
          ),
          Effect.tapError(() =>
            Effect.forEach(
              [...entries.values()].filter((entry) => entry.extension.manifest.backend),
              (entry) =>
                setState(
                  entry.extension.manifest.id,
                  "down",
                  undefined,
                  "Desktop backend owner disconnected.",
                ),
              { discard: true },
            ),
          ),
        ),
    ).pipe(Effect.retry({ schedule: Schedule.spaced("1 second") }), Effect.forkScoped);
  }

  for (const extension of extensions) {
    if (!extension.manifest.backend) continue;
    const id = extension.manifest.id;
    const borrowed = descriptors?.find((descriptor) => descriptor.extensionId === id);
    const supervise = controlOrigin
      ? Effect.never
      : borrowed
        ? Effect.gen(function* () {
            const url = URL.parse(borrowed.url);
            if (
              !url ||
              url.protocol !== "http:" ||
              url.hostname !== "127.0.0.1" ||
              url.username ||
              url.password ||
              url.pathname !== "/" ||
              url.search ||
              url.hash
            ) {
              return yield* setState(id, "failed", undefined, "Invalid backend descriptor.");
            }
            const descriptor = { ...borrowed, url: url.origin };
            // Desktop preserves this authenticated endpoint across launches; refresh only the instance identity.
            yield* BackendSupervisor.probe(descriptor, true).pipe(
              Effect.timeout(2_000),
              Effect.matchEffect({
                onSuccess: (current) => setState(id, "ready", current),
                onFailure: () => setState(id, "failed", undefined, "Backend readiness failed."),
              }),
              Effect.repeat({ schedule: Schedule.spaced("1 second") }),
            );
          })
        : descriptors !== undefined
          ? setState(
              id,
              "failed",
              undefined,
              config.extensionHost?.failures?.find((failure) => failure.extensionId === id)
                ?.message ?? "Desktop backend unavailable.",
            )
          : BackendSupervisor.supervise(
              (ready) =>
                BackendSupervisor.launch(
                  extension,
                  ready,
                  {
                    // Bundled servers never watch, even if a dev URL was supplied externally.
                    development:
                      config.devUrl !== undefined &&
                      import.meta.url.endsWith("/src/extensions/ExtensionHost.ts"),
                    onReload: () =>
                      setState(id, "reloading", undefined, "Backend sources changed."),
                    onReloadFailed: (message) =>
                      Effect.flatMap(
                        Effect.sync(() => entries.get(id)?.descriptor),
                        (descriptor) => setState(id, "ready", descriptor, message),
                      ),
                    platform,
                    stateDir: config.stateDir,
                    logsDir: config.logsDir,
                    environment: inherited,
                    executable,
                  },
                  (descriptor) => setState(id, "ready", descriptor),
                ),
              (state, message) => setState(id, state, undefined, message),
              {
                restart: entries.get(id)!.restart.wait,
                onAttempt: (attempt) =>
                  Effect.sync(() => {
                    const entry = entries.get(id)!;
                    entry.status = {
                      ...entry.status,
                      lifecycle: {
                        ...(entry.status.lifecycle ?? {
                          state: "starting",
                          since: clock.currentTimeMillisUnsafe(),
                        }),
                        attempt,
                      },
                    };
                  }),
              },
            );
    yield* Effect.addFinalizer(() => setState(id, "stopped"));
    yield* supervise.pipe(Effect.forkScoped);
  }

  return ExtensionHost.of({
    threadHostUrl: `http://${callbackHost}:${config.port}`,
    hasThreadPermission: Effect.fn("ExtensionHost.hasThreadPermission")((id) =>
      Effect.sync(
        () => entries.get(id)?.extension.manifest.permissions?.includes("threads") ?? false,
      ),
    ),
    status: Effect.sync(() => ({ extensions: [...entries.values()].map((entry) => entry.status) })),
    resolveRoute: Effect.fn("ExtensionHost.resolveRoute")((method, rawUrl) =>
      Effect.sync(() => routeScope(extensions, method, rawUrl)),
    ),
    backend: Effect.fn("ExtensionHost.backend")((id) =>
      Effect.sync(() => entries.get(id)?.descriptor),
    ),
    lifecycle: Effect.fn("ExtensionHost.lifecycle")((id) =>
      Effect.sync(() => {
        const entry = entries.get(id);
        return entry?.extension.manifest.backend
          ? (entry.status.lifecycle ?? {
              state: "starting" as const,
              since: clock.currentTimeMillisUnsafe(),
            })
          : undefined;
      }),
    ),
    restart: Effect.fn("ExtensionHost.restart")(function* (id) {
      const entry = entries.get(id);
      if (!entry?.extension.manifest.backend) return undefined;
      yield* setState(id, "restarting", undefined, "Restart requested.");
      if (control && controlOrigin) {
        yield* Effect.scoped(
          HttpClient.withScope(client)
            .post(`${controlOrigin}/restart/${id}`, {
              headers: { authorization: `Bearer ${control.token}` },
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.timeout(5_000),
              Effect.mapError((cause) => new ExtensionHostError({ stage: "launch", cause })),
              Effect.tapError(() =>
                setState(id, "down", undefined, "Could not reach the desktop backend owner."),
              ),
            ),
        );
      } else if (descriptors !== undefined) {
        return yield* new ExtensionHostError({
          stage: "launch",
          cause: "Desktop owner control unavailable",
        });
      } else entry.restart.request();
      return entry.status.lifecycle;
    }),
    awaitState: Effect.fn("ExtensionHost.awaitState")((id, state) =>
      Effect.callback<ExtensionStatus>((resume) => {
        const entry = entries.get(id);
        if (!entry) return resume(Effect.die("Unknown extension"));
        const listener = (status: ExtensionStatus) => {
          if (status.backend === state) resume(Effect.succeed(status));
        };
        entry.listeners.add(listener);
        listener(entry.status);
        return Effect.sync(() => {
          entry.listeners.delete(listener);
        });
      }),
    ),
  });
});

export const layerWithOptions = (options: HostOptions) =>
  Layer.effect(ExtensionHost, make(options));
export const layer = Layer.effect(ExtensionHost, Effect.flatMap(Options, make));
