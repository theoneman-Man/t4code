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
} from "@t3tools/extension-sdk/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
        } as ExtensionStatus,
        descriptor: undefined as ReadyBackendDescriptor | undefined,
        listeners: new Set<(status: ExtensionStatus) => void>(),
      },
    ]),
  );
  const setState = Effect.fn("ExtensionHost.setState")(
    (
      id: string,
      backend: ExtensionBackendState,
      descriptor?: ReadyBackendDescriptor,
      message?: string,
    ) =>
      Effect.sync(() => {
        const entry = entries.get(id)!;
        entry.status = { id, backend, ...(message ? { message } : {}) };
        entry.descriptor = descriptor;
        for (const listener of entry.listeners) listener(entry.status);
      }),
  );

  for (const extension of extensions) {
    if (!extension.manifest.backend) continue;
    const id = extension.manifest.id;
    const borrowed = descriptors?.find((descriptor) => descriptor.extensionId === id);
    const supervise = borrowed
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
            Effect.matchEffect({
              onSuccess: (current) => setState(id, "ready", current),
              onFailure: () => setState(id, "failed", undefined, "Backend readiness failed."),
            }),
          );
          return yield* Effect.never;
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
                  onReload: () => setState(id, "restarting", undefined, "Backend sources changed."),
                  platform,
                  stateDir: config.stateDir,
                  logsDir: config.logsDir,
                  environment: inherited,
                  executable,
                },
                (descriptor) => setState(id, "ready", descriptor),
              ),
            (state, message) => setState(id, state, undefined, message),
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
