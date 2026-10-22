// Node owns subprocess handles, inherited log descriptors and loopback port allocation here.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { EXTENSION_LIST_FILE } from "@t3tools/extension-sdk/manifest";
import { loadExtensions, type ResolvedExtension } from "@t3tools/extension-sdk/node";
import {
  EXTENSION_BACKEND_ENV,
  EXTENSION_READY_PATH,
  EXTENSION_READY_TIMEOUT_MS,
  type ExtensionBackendState,
  type ExtensionStatus,
  type ExtensionStatusResponse,
} from "@t3tools/extension-sdk/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse, FetchHttpClient } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import { routeScope } from "./proxy.ts";
import * as BackendSupervisor from "./BackendSupervisor.ts";

/** A desktop-owned backend is borrowed; the server never spawns or stops it. */
export interface ReadyBackendDescriptor {
  readonly extensionId: string;
  readonly url: string;
  readonly token: string;
  readonly instanceId: string;
  readonly dataDir: string;
}

export interface HostOptions {
  /** Development source root for now; packaged hosts supply their own root/list. */
  readonly hostRoot?: string;
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

class ExtensionBackendUnavailableError extends Schema.TaggedError<ExtensionBackendUnavailableError>()(
  "ExtensionBackendUnavailableError",
  {
    reason: Schema.Literals(["identity_mismatch", "exited"]),
  },
) {
  override get message() {
    return "Extension backend is unavailable.";
  }
}

export class ExtensionHost extends Context.Service<
  ExtensionHost,
  {
    readonly status: Effect.Effect<ExtensionStatusResponse>;
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

const sourceRoot = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));

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
const readySchema = Schema.Struct({
  protocol: Schema.Literal(1),
  extensionId: Schema.String,
  instanceId: Schema.String,
  dataDir: Schema.String,
});

const freePort = Effect.fn("ExtensionHost.freePort")(function* () {
  return yield* Effect.acquireUseRelease(
    Effect.callback<{ server: NodeNet.Server; port: number }, ExtensionHostError>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", (cause) =>
        resume(Effect.fail(new ExtensionHostError({ stage: "launch", cause }))),
      );
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string")
          resume(Effect.succeed({ server, port: address.port }));
      });
    }),
    ({ port }) => Effect.succeed(port),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

export function backendEnvironment(
  inherited: NodeJS.ProcessEnv,
  descriptor: ReadyBackendDescriptor,
) {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([name]) => !/^T[34](?:_|CODE_)/i.test(name)),
  );
  return {
    ...env,
    [EXTENSION_BACKEND_ENV.id]: descriptor.extensionId,
    [EXTENSION_BACKEND_ENV.port]: new URL(descriptor.url).port,
    [EXTENSION_BACKEND_ENV.token]: descriptor.token,
    [EXTENSION_BACKEND_ENV.dataDir]: descriptor.dataDir,
    [EXTENSION_BACKEND_ENV.instance]: descriptor.instanceId,
  };
}

const probe = Effect.fn("ExtensionHost.probe")(function* (descriptor: ReadyBackendDescriptor) {
  const client = yield* HttpClient.HttpClient;
  const body = yield* Effect.scoped(
    HttpClient.withScope(client)
      .get(`${descriptor.url}${EXTENSION_READY_PATH}`, {
        headers: { authorization: `Bearer ${descriptor.token}` },
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      ),
  ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis") }));
  const ready = yield* Schema.decodeUnknownEffect(readySchema)(body).pipe(
    Effect.mapError((cause) => new ExtensionHostError({ stage: "identity", cause })),
  );
  if (
    ready.extensionId !== descriptor.extensionId ||
    ready.instanceId !== descriptor.instanceId ||
    ready.dataDir !== descriptor.dataDir
  ) {
    return yield* new ExtensionBackendUnavailableError({ reason: "identity_mismatch" });
  }
}, Effect.timeout(EXTENSION_READY_TIMEOUT_MS));

const stopChild = Effect.fn("ExtensionHost.stopChild")(function* (
  child: NodeChildProcess.ChildProcess,
  exited: Promise<void>,
) {
  const platform = yield* HostProcess.Platform;
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    if (platform === "win32") {
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const killer = NodeChildProcess.spawn(
              "taskkill",
              ["/PID", String(child.pid), "/T", "/F"],
              {
                windowsHide: true,
                stdio: "ignore",
              },
            );
            killer.once("error", () => {
              child.kill();
              resolve();
            });
            killer.once("exit", () => {
              child.kill();
              resolve();
            });
          }),
      );
    } else {
      child.kill("SIGKILL");
    }
  }
  yield* Effect.promise(() => exited);
});

const make = Effect.fn("ExtensionHost.make")(function* (options: HostOptions) {
  const config = yield* ServerConfig.ServerConfig;
  const inherited = yield* HostProcess.Environment;
  const executable = yield* HostProcess.ExecutablePath;
  const hostRoot = options.hostRoot ?? sourceRoot;
  const listFile = options.listFile ?? NodePath.join(hostRoot, EXTENSION_LIST_FILE);
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

  const launch = Effect.fn("ExtensionHost.launch")(function* (
    extension: ResolvedExtension,
    ready: Effect.Effect<void, never, Scope.Scope>,
  ) {
    const id = extension.manifest.id;
    const port = yield* freePort();
    const descriptor: ReadyBackendDescriptor = {
      extensionId: id,
      url: `http://127.0.0.1:${port}`,
      token: NodeCrypto.randomBytes(32).toString("base64url"),
      instanceId: NodeCrypto.randomUUID(),
      dataDir: extension.dataDir ?? NodePath.join(config.stateDir, "extensions", id),
    };
    const logDir = NodePath.join(config.logsDir, "extensions");
    yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          NodeFSP.mkdir(descriptor.dataDir, { recursive: true }),
          NodeFSP.mkdir(logDir, { recursive: true }),
        ]),
      catch: (cause) => new ExtensionHostError({ stage: "launch", cause }),
    });
    const log = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(NodePath.join(logDir, `${id}.log`), "a"),
        catch: (cause) => new ExtensionHostError({ stage: "launch", cause }),
      }),
      (file) => Effect.promise(() => file.close()),
    );
    const processHandle = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const [command, ...args] = extension.manifest.backend!.command;
          const child = NodeChildProcess.spawn(command === "node" ? executable : command, args, {
            cwd: extension.backendCwd,
            env: backendEnvironment(inherited, descriptor),
            shell: false,
            windowsHide: true,
            stdio: ["ignore", log.fd, log.fd],
          });
          const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
          // Consume spawn errors immediately, before readiness opens its first connection.
          child.on("error", () => {});
          return { child, exited };
        },
        catch: (cause) => new ExtensionHostError({ stage: "launch", cause }),
      }),
      ({ child, exited }) => stopChild(child, exited),
    );
    yield* Effect.raceFirst(
      probe(descriptor),
      Effect.promise(() => processHandle.exited).pipe(
        Effect.andThen(Effect.fail(new ExtensionBackendUnavailableError({ reason: "exited" }))),
      ),
    );
    yield* ready;
    yield* setState(id, "ready", descriptor);
    yield* Effect.promise(() => processHandle.exited);
  });

  for (const extension of extensions) {
    if (!extension.manifest.backend) continue;
    const id = extension.manifest.id;
    const borrowed = options.descriptors?.find((descriptor) => descriptor.extensionId === id);
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
          yield* probe(descriptor).pipe(
            Effect.matchEffect({
              onSuccess: () => setState(id, "ready", descriptor),
              onFailure: () => setState(id, "failed", undefined, "Backend readiness failed."),
            }),
          );
          return yield* Effect.never;
        })
      : BackendSupervisor.supervise(
          (ready) => launch(extension, ready),
          (state, message) => setState(id, state, undefined, message),
        );
    yield* Effect.addFinalizer(() => setState(id, "stopped"));
    yield* supervise.pipe(Effect.forkScoped);
  }

  return ExtensionHost.of({
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
