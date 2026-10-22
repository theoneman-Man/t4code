import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpMethod } from "effect/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  type EnvironmentHttpAuthHeaders,
} from "./environmentHttpAuth.ts";

class ExtensionHttpError extends Data.TaggedError("ExtensionHttpError")<{ cause: unknown }> {}

function extensionHttpUrl(baseUrl: string, path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path))
    throw new Error("Extension HTTP paths must be absolute environment paths.");
  const url = new URL(path, baseUrl);
  if (url.pathname !== "/api/extensions" && !/^\/ext\/[^/]+\//.test(url.pathname))
    throw new Error("Extension HTTP paths must address the extension proxy or status endpoint.");
  return url.toString();
}

export const fetchEnvironmentExtensionHttp = Effect.fn(
  "clientRuntime.state.fetchEnvironmentExtensionHttp",
)(function* (prepared: PreparedConnection, path: string, init: RequestInit = {}) {
  const method = init.method?.toUpperCase() ?? "GET";
  if (!HttpMethod.isHttpMethod(method))
    return yield* new ExtensionHttpError({ cause: `Unsupported extension HTTP method: ${method}` });
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  let requestUrl = "";
  return yield* executeAuthenticatedEnvironmentHttpRequest<Response, ExtensionHttpError, never>({
    prepared,
    signer,
    remoteAuthorization,
    method,
    urlForBase: (baseUrl) => {
      requestUrl = extensionHttpUrl(baseUrl, path);
      return requestUrl;
    },
    timeoutMs: 30_000,
    request: Effect.fn("clientRuntime.state.extensionHttp.request")(function* ({
      headers,
    }: {
      headers: EnvironmentHttpAuthHeaders;
    }): Effect.fn.Return<Response, ExtensionHttpError> {
      const defaults = Option.getOrElse(
        yield* Effect.serviceOption(FetchHttpClient.RequestInit),
        (): RequestInit => ({}),
      );
      const requestHeaders = new Headers(init.headers);
      requestHeaders.delete("authorization");
      requestHeaders.delete("dpop");
      for (const [name, value] of Object.entries(headers))
        if (value) requestHeaders.set(name, value);
      return yield* Effect.tryPromise({
        try: (signal) =>
          // @effect-diagnostics-next-line globalFetchInEffect:off - Keep the native streaming body alive after headers; shared environment HTTP handles authentication and renewal.
          fetch(requestUrl, {
            ...init,
            ...defaults,
            credentials: defaults.credentials ?? "omit",
            headers: requestHeaders,
            redirect: "error",
            signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
          }),
        catch: (cause) => new ExtensionHttpError({ cause }),
      });
    }),
    isUnauthorizedResponse: (response) => {
      if (response.status !== 401) return false;
      void response.body?.cancel();
      return true;
    },
  });
});
