// Node owns subprocess handles, inherited log descriptors and loopback allocation.
// @effect-diagnostics nodeBuiltinImport:off -- This module is the Node process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import type { ResolvedExtension } from "../node.ts";
import {
  EXTENSION_BACKEND_ENV,
  EXTENSION_READY_PATH,
  EXTENSION_READY_TIMEOUT_MS,
} from "../protocol.ts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse, FetchHttpClient } from "effect/http";

/** A desktop-owned backend is borrowed; the server never spawns or stops it. */
export interface ReadyBackendDescriptor {
  readonly extensionId: string;
  readonly url: string;
  readonly token: string;
  readonly instanceId: string;
  readonly dataDir: string;
}

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
    Object.entries(inherited).filter(
      ([name]) => !/^T[34](?:_|CODE_)/i.test(name) && name !== "ELECTRON_RUN_AS_NODE",
    ),
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

export const probe = Effect.fn("ExtensionHost.probe")(function* (
  descriptor: ReadyBackendDescriptor,
  refreshInstance = false,
) {
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
    (!refreshInstance && ready.instanceId !== descriptor.instanceId) ||
    ready.dataDir !== descriptor.dataDir
  ) {
    return yield* new ExtensionBackendUnavailableError({ reason: "identity_mismatch" });
  }
  return { ...descriptor, instanceId: ready.instanceId };
}, Effect.timeout(EXTENSION_READY_TIMEOUT_MS));

const stopChild = Effect.fn("ExtensionHost.stopChild")(function* (
  child: NodeChildProcess.ChildProcess,
  exited: Promise<void>,
  platform: NodeJS.Platform,
) {
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
      // Each Unix launch owns a process group, so grandchildren stop with their parent.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  yield* Effect.promise(() => exited);
});

export interface ProcessOptions {
  readonly platform: NodeJS.Platform;
  readonly stateDir: string;
  readonly logsDir: string;
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onStarting?: (descriptor: ReadyBackendDescriptor) => Effect.Effect<void>;
}

// Desktop keeps URL and bearer stable across child restarts. Only instanceId rotates.
// Servers proxy through that stable endpoint; their next bootstrap gets the new identity.
export const allocateEndpoint = Effect.fn("ExtensionHost.allocateEndpoint")(function* () {
  const port = yield* freePort();
  return {
    url: `http://127.0.0.1:${port}`,
    token: NodeCrypto.randomBytes(32).toString("base64url"),
  };
});

export const launch = Effect.fn("ExtensionHost.launch")(function* (
  extension: ResolvedExtension,
  ready: Effect.Effect<void, never, Scope.Scope>,
  options: ProcessOptions,
  onReady: (descriptor: ReadyBackendDescriptor) => Effect.Effect<void>,
  endpoint?: { readonly url: string; readonly token: string },
) {
  const id = extension.manifest.id;
  const port = endpoint ? undefined : yield* freePort();
  const descriptor: ReadyBackendDescriptor = {
    extensionId: id,
    url: endpoint?.url ?? `http://127.0.0.1:${port}`,
    token: endpoint?.token ?? NodeCrypto.randomBytes(32).toString("base64url"),
    instanceId: NodeCrypto.randomUUID(),
    dataDir: extension.dataDir ?? NodePath.join(options.stateDir, "extensions", id),
  };
  const logDir = NodePath.join(options.logsDir, "extensions");
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
        const child = NodeChildProcess.spawn(
          command === "node" ? (options.executable ?? process.execPath) : command,
          args,
          {
            cwd: extension.backendCwd,
            env: backendEnvironment(options.environment ?? process.env, descriptor),
            shell: false,
            detached: options.platform !== "win32",
            windowsHide: true,
            stdio: ["ignore", log.fd, log.fd],
          },
        );
        const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
        // Consume spawn errors immediately, before readiness opens its first connection.
        child.on("error", () => {});
        return { child, exited };
      },
      catch: (cause) => new ExtensionHostError({ stage: "launch", cause }),
    }),
    ({ child, exited }) => stopChild(child, exited, options.platform),
  );
  yield* options.onStarting?.(descriptor) ?? Effect.void;
  yield* Effect.raceFirst(
    probe(descriptor),
    Effect.promise(() => processHandle.exited).pipe(
      Effect.andThen(Effect.fail(new ExtensionBackendUnavailableError({ reason: "exited" }))),
    ),
  );
  yield* ready;
  yield* onReady(descriptor);
  yield* Effect.promise(() => processHandle.exited);
});
