import type { ExtensionRouteScope } from "@t3tools/extension-sdk/manifest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as ExtensionHost from "./ExtensionHost.ts";
import { requestHeaders, responseHeaders } from "./proxy.ts";

export class ExtensionProxyError extends Schema.TaggedError<ExtensionProxyError>()(
  "ExtensionProxyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Extension backend request failed.";
  }
}

export class ExtensionProxy extends Context.Service<
  ExtensionProxy,
  {
    readonly forward: (
      request: HttpServerRequest.HttpServerRequest,
      target: {
        readonly id: string;
        readonly path: string;
        readonly search: string;
        readonly scope: ExtensionRouteScope;
      },
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, ExtensionProxyError, Scope.Scope>;
  }
>()("t3/extensions/ExtensionProxy") {}

const make = Effect.gen(function* () {
  const host = yield* ExtensionHost.ExtensionHost;
  const client = yield* HttpClient.HttpClient;
  const forward = Effect.fn("ExtensionProxy.forward")(function* (
    request: HttpServerRequest.HttpServerRequest,
    target: {
      readonly id: string;
      readonly path: string;
      readonly search: string;
      readonly scope: ExtensionRouteScope;
    },
  ) {
    const backend = yield* host.backend(target.id);
    if (!backend)
      return HttpServerResponse.jsonUnsafe({ error: "extension_unavailable" }, { status: 503 });
    const upstreamRequest = HttpClientRequest.make(request.method)(
      `${backend.url}${target.path}${target.search}`,
    ).pipe(
      HttpClientRequest.setHeaders(requestHeaders(request.headers, backend.token, target.scope)),
      request.method === "GET" || request.method === "HEAD"
        ? (self) => self
        : HttpClientRequest.bodyStream(request.stream, {
            contentType: request.headers["content-type"],
          }),
    );
    // The request scope owns the upstream stream and aborts fetch when the client disconnects.
    const response = yield* HttpClient.withScope(client)
      .execute(upstreamRequest)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.mapError((cause) => new ExtensionProxyError({ cause })),
      );
    const headers = responseHeaders(response.headers);
    return HttpServerResponse.stream(response.stream, {
      status: response.status,
      headers,
      ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
    });
  });
  return ExtensionProxy.of({ forward });
});

export const layer = Layer.effect(ExtensionProxy, make);
