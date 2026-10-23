import type { ExtensionRouteScope } from "@t3tools/extension-sdk/manifest";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
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
    const diagnostic = {
      extensionId: target.id,
      method: request.method,
      path: target.path.split(/[?#]/, 1)[0],
    };
    const backend = yield* host.backend(target.id);
    if (!backend) {
      yield* Effect.logWarning("Extension proxy backend unavailable.", {
        ...diagnostic,
        reason: "BackendUnavailable",
      });
      return HttpServerResponse.jsonUnsafe({ error: "extension_unavailable" }, { status: 503 });
    }
    const upstreamRequest = HttpClientRequest.make(request.method)(
      `${backend.url}${target.path}${target.search}`,
    ).pipe(
      HttpClientRequest.setHeaders(requestHeaders(request.headers, backend.token, target.scope)),
      HttpClientRequest.setHeader("x-t4-thread-host", host.threadHostUrl),
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
        Effect.catchTags({
          HttpClientError: (error) => {
            if (
              (request.method !== "GET" && request.method !== "HEAD") ||
              upstreamRequest.body._tag === "Stream" ||
              error.reason._tag !== "TransportError" ||
              error.response !== undefined
            )
              return Effect.fail(error);
            return Effect.gen(function* () {
              // A new dispatcher cannot reuse a stale pooled socket. Its lifetime includes the response stream.
              const dispatcher = yield* NodeHttpClient.makeDispatcher;
              const retryClient = yield* NodeHttpClient.makeUndici.pipe(
                Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
              );
              return yield* HttpClient.withScope(retryClient).execute(upstreamRequest);
            });
          },
        }),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.tapError((error) =>
          Effect.logWarning("Extension proxy request failed.", {
            ...diagnostic,
            errorTag: error._tag,
            reason: error.reason._tag,
          }),
        ),
        Effect.mapError((cause) => new ExtensionProxyError({ cause })),
      );
    const headers = responseHeaders(response.headers);
    const stream = response.stream.pipe(
      Stream.tapError((error) =>
        Effect.logWarning("Extension proxy response stream failed.", {
          ...diagnostic,
          errorTag: HttpClientError.isHttpClientError(error) ? error._tag : "UnknownError",
          reason: HttpClientError.isHttpClientError(error) ? error.reason._tag : "UnknownError",
        }),
      ),
    );
    return HttpServerResponse.stream(stream, {
      status: response.status,
      headers,
      ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
    });
  });
  return ExtensionProxy.of({ forward });
});

export const layer = Layer.effect(ExtensionProxy, make);
