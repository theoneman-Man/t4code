// @effect-diagnostics nodeBuiltinImport:off -- Desktop-owned loopback control transport.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ExtensionBackendLifecycle } from "../protocol.ts";
import type { ReadyBackendDescriptor } from "./process.ts";

export interface BackendOwnerSnapshot {
  readonly id: string;
  readonly lifecycle: ExtensionBackendLifecycle;
  readonly descriptor?: ReadyBackendDescriptor;
}

export const makeBackendControl = Effect.fn("ExtensionHost.makeBackendControl")(
  function* (options: {
    readonly snapshots: () => readonly BackendOwnerSnapshot[];
    readonly restart: (id: string) => boolean;
  }) {
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    const clients = new Set<NodeHttp.ServerResponse>();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeHttp.createServer((request, response) => {
          if (request.headers.authorization !== `Bearer ${token}`) {
            response.writeHead(401).end();
            return;
          }
          if (request.method === "GET" && request.url === "/states") {
            response.writeHead(200, {
              "content-type": "application/x-ndjson",
              "cache-control": "no-store",
            });
            clients.add(response);
            response.on("close", () => clients.delete(response));
            for (const snapshot of options.snapshots())
              response.write(JSON.stringify(snapshot) + "\n");
            response.flushHeaders();
            return;
          }
          const id = request.url?.match(/^\/restart\/([a-z][a-z0-9-]{0,39})$/)?.[1];
          if (request.method === "POST" && id) {
            response.writeHead(options.restart(id) ? 202 : 404).end();
            return;
          }
          response.writeHead(404).end();
        }),
      ),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const client of clients) client.destroy();
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
    );
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      return yield* Effect.die("Expected loopback address");
    yield* Effect.sync(() => {
      // Keep idle owner streams open through HTTP client body deadlines.
      for (const client of clients) if (!client.write("\n")) client.destroy();
    }).pipe(Effect.repeat({ schedule: Schedule.spaced("15 seconds") }), Effect.forkScoped);
    return {
      descriptor: { url: `http://127.0.0.1:${address.port}`, token },
      publish(snapshot: BackendOwnerSnapshot) {
        const line = JSON.stringify(snapshot) + "\n";
        for (const client of clients) {
          // A stalled server reconnects for a fresh snapshot instead of accumulating unbounded writes.
          if (!client.write(line)) client.destroy();
        }
      },
    };
  },
);
