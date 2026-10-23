// @effect-diagnostics nodeBuiltinImport:off -- Backend launch credentials use constant-time comparison.
import * as NodeCrypto from "node:crypto";
import { LaunchThreadInput, SendThreadInput, THREADS_PATH } from "@t3tools/extension-sdk/threads";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as Host from "./ExtensionHost.ts";
import * as Threads from "./ExtensionThreads.ts";
import * as Operations from "./ThreadOperations.ts";
import { parseProxyTarget } from "./proxy.ts";

const invalid = () =>
  new Operations.ExtensionThreadError({ status: 400, reason: "invalid_request" });
const decodeLaunch = Schema.decodeUnknownEffect(LaunchThreadInput);
const decodeSend = Schema.decodeUnknownEffect(SendThreadInput);
const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const host = yield* Host.ExtensionHost;
  const service = yield* Threads.ExtensionThreads;
  const target = parseProxyTarget(request.url);
  if (!target) return yield* invalid();
  const backend = yield* host.backend(target.id);
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${backend?.token ?? ""}`);
  const isBackend =
    backend !== undefined &&
    supplied.length === expected.length &&
    NodeCrypto.timingSafeEqual(supplied, expected);
  if (!isBackend) {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    const required =
      request.method === "GET" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope;
    if (!session.scopes.includes(required)) return yield* failEnvironmentScopeRequired(required);
  }
  if (!(yield* host.hasThreadPermission(target.id)))
    return yield* new Operations.ExtensionThreadError({
      status: 403,
      reason: "permission_required",
    });
  const suffix = target.path.slice(THREADS_PATH.length);
  if (suffix === "" && request.method === "POST") {
    const body = yield* request.json.pipe(Effect.mapError(invalid));
    const input = yield* decodeLaunch(body).pipe(Effect.mapError(invalid));
    return HttpServerResponse.jsonUnsafe({
      threadId: yield* service.launchThread(target.id, input),
    });
  }
  const match = /^\/([^/]+)(\/messages|\/events)?$/.exec(suffix);
  if (!match?.[1]) return HttpServerResponse.empty({ status: 404 });
  const threadId = decodeURIComponent(match[1]);
  const query = new URLSearchParams(target.search);
  if (!match[2] && request.method === "GET")
    return HttpServerResponse.jsonUnsafe(
      yield* service.readThread(target.id, threadId, query.get("after") ?? undefined),
    );
  if (match[2] === "/messages" && request.method === "POST") {
    const body = yield* request.json.pipe(Effect.mapError(invalid));
    const input = yield* decodeSend(body).pipe(Effect.mapError(invalid));
    yield* service.sendToThread(target.id, threadId, input.text);
    return HttpServerResponse.jsonUnsafe({});
  }
  if (match[2] === "/events" && request.method === "GET") {
    const cursor = query.get("cursor") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
      return yield* invalid();
    const events = yield* service.subscribeThread(target.id, threadId, Number(cursor));
    const frames = events.pipe(
      Stream.map(
        (event) =>
          `id: ${event.cursor}\nevent: ${event.topic}\ndata: ${JSON.stringify(event.data)}\n\n`,
      ),
    );
    const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"));
    return HttpServerResponse.stream(
      Stream.merge(frames, heartbeat, { haltStrategy: "left" }).pipe(
        Stream.map((frame) => new TextEncoder().encode(frame)),
      ),
      {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
      },
    );
  }
  return HttpServerResponse.empty({ status: 404 });
}).pipe(
  Effect.catchTags({
    ExtensionThreadError: (error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: error.reason }, { status: error.status }),
      ),
  }),
);

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      Host.ExtensionHost | Threads.ExtensionThreads | EnvironmentAuth.EnvironmentAuth
    >();
    yield* router.add(
      "*",
      `/ext/:id${THREADS_PATH}/*`,
      handler.pipe(Effect.provideContext(services)),
    );
  }),
);
