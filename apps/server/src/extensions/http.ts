import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  EXTENSION_PROXY_PREFIX,
  EXTENSION_STATUS_PATH,
  EXTENSION_HOST_STATE_PATH,
  EXTENSION_HOST_RESTART_PATH,
} from "@t3tools/extension-sdk/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as ExtensionHost from "./ExtensionHost.ts";
import * as ExtensionProxy from "./ExtensionProxy.ts";
import { parseProxyTarget } from "./proxy.ts";

const authenticate = Effect.fn("ExtensionHttp.authenticate")(function* (scope: "read" | "operate") {
  const request = yield* HttpServerRequest.HttpServerRequest;
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
  const required = scope === "read" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope;
  if (!session.scopes.includes(required)) return yield* failEnvironmentScopeRequired(required);
});

const proxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const host = yield* ExtensionHost.ExtensionHost;
  const hostTarget = parseProxyTarget(request.url);
  if (hostTarget?.path === EXTENSION_HOST_STATE_PATH && request.method === "GET") {
    yield* authenticate("read");
    const lifecycle = yield* host.lifecycle(hostTarget.id);
    return lifecycle
      ? HttpServerResponse.jsonUnsafe(lifecycle, { headers: { "cache-control": "no-store" } })
      : HttpServerResponse.empty({ status: 404 });
  }
  if (hostTarget?.path === EXTENSION_HOST_RESTART_PATH && request.method === "POST") {
    yield* authenticate("operate");
    return yield* host.restart(hostTarget.id).pipe(
      Effect.map((lifecycle) =>
        lifecycle
          ? HttpServerResponse.jsonUnsafe(lifecycle, {
              status: 202,
              headers: { "cache-control": "no-store" },
            })
          : HttpServerResponse.empty({ status: 404 }),
      ),
      Effect.catchTags({
        ExtensionHostError: () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: "restart_unavailable" },
              { status: 503, headers: { "retry-after": "1", "cache-control": "no-store" } },
            ),
          ),
      }),
    );
  }
  const target = yield* host.resolveRoute(request.method, request.url);
  yield* authenticate(target?.scope ?? "read");
  if (!parseProxyTarget(request.url))
    return HttpServerResponse.jsonUnsafe({ error: "invalid_path" }, { status: 400 });
  if (!target) return HttpServerResponse.empty({ status: 404 });
  const service = yield* ExtensionProxy.ExtensionProxy;
  return yield* service.forward(request, target).pipe(
    Effect.catchTags({
      ExtensionProxyError: () =>
        Effect.map(host.lifecycle(target.id), (lifecycle) =>
          HttpServerResponse.jsonUnsafe(
            { state: lifecycle?.state ?? "down", retryAfterMs: 1000 },
            { status: 503, headers: { "retry-after": "1", "cache-control": "no-store" } },
          ),
        ),
    }),
  );
});

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      ExtensionHost.ExtensionHost | ExtensionProxy.ExtensionProxy | EnvironmentAuth.EnvironmentAuth
    >();
    yield* router.add(
      "*",
      `${EXTENSION_PROXY_PREFIX}/*`,
      proxy.pipe(Effect.provideContext(services)),
    );
    yield* router.add(
      "GET",
      EXTENSION_STATUS_PATH,
      Effect.gen(function* () {
        yield* authenticate("read");
        const host = yield* ExtensionHost.ExtensionHost;
        return HttpServerResponse.jsonUnsafe(yield* host.status);
      }).pipe(Effect.provideContext(services)),
    );
  }),
).pipe(Layer.provide(ExtensionProxy.layer));
