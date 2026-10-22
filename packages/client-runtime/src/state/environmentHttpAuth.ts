import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import { FetchHttpClient, type HttpMethod, type HttpClient } from "effect/http";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection, PreparedHttpAuthorization } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
  readonly dpop?: string;
}

export function withOrchestrationProtocolHeader(
  headers: EnvironmentHttpAuthHeaders,
): EnvironmentHttpAuthHeaders & {
  readonly [ORCHESTRATION_PROTOCOL_HEADER]: typeof ORCHESTRATION_PROTOCOL_VERSION_TEXT;
} {
  return {
    ...headers,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  };
}

type RequestOptions<A> = {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly method: HttpMethod.HttpMethod;
  readonly timeoutMs: number;
  /** Some endpoints report rejected credentials in a successful response. */
  readonly isUnauthorizedResponse?: (response: NoInfer<A>) => boolean;
};

type GroupRequest<
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
> = {
  readonly group: Group;
  // Use the contract's encoding so the proof signs the URL actually sent by the client.
  readonly url: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>[Group]) => string;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
};

type PathRequest<A, E, R> = {
  readonly group?: never;
  readonly urlForBase: (httpBaseUrl: string) => string;
  readonly request: (input: {
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
};

/**
 * Primary/local environments with no bearer or DPoP credential authenticate the
 * browser via a session cookie. A cross-origin `fetch` does not send cookies by
 * default, so those requests must opt into credentialed mode; bearer/DPoP
 * connections carry their credential in a header and need no cookies. Applied
 * per-request via `FetchHttpClient.RequestInit`, which the fetch client reads
 * from the fiber context at request time.
 */
const withEnvironmentCredentials = <A, E, R>(
  authorization: PreparedHttpAuthorization | null,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  authorization === null
    ? request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
    : request;

const buildEnvironmentAuthHeaders = Effect.fn("environmentHttpAuth.buildEnvironmentAuthHeaders")(
  function* (
    authorization: PreparedHttpAuthorization | null,
    method: HttpMethod.HttpMethod,
    url: string,
    signer: Option.Option<ManagedRelayDpopSigner["Service"]>,
  ): Effect.fn.Return<EnvironmentHttpAuthHeaders, RemoteEnvironmentAuthFetchError> {
    if (authorization === null) {
      return {};
    }
    if (authorization._tag === "Bearer") {
      return { authorization: `Bearer ${authorization.token}` };
    }
    if (Option.isNone(signer)) {
      return yield* new RemoteEnvironmentAuthFetchError({
        message: "No DPoP signer is available to authorize the environment request.",
        cause: authorization._tag,
      });
    }
    const proof = yield* signer.value
      .createProof({ method, url, accessToken: authorization.accessToken })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RemoteEnvironmentAuthFetchError({
              message: "Could not create the environment request authorization proof.",
              cause,
            }),
        ),
      );
    return { authorization: `DPoP ${authorization.accessToken}`, dpop: proof };
  },
);

/**
 * A DPoP request is T3 Connect work, so its span starts an exported trace that
 * the environment continues; its local caller's span would leave that trace
 * without a root.
 */
export function executeAuthenticatedEnvironmentHttpRequest<
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(
  input: RequestOptions<A> & GroupRequest<Group, A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, HttpClient.HttpClient | R>;
export function executeAuthenticatedEnvironmentHttpRequest<A, E, R>(
  input: RequestOptions<A> & PathRequest<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, HttpClient.HttpClient | R>;
export function executeAuthenticatedEnvironmentHttpRequest<
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(input: RequestOptions<A> & (GroupRequest<Group, A, E, R> | PathRequest<A, E, R>)) {
  return input.prepared.httpAuthorization?._tag === "Dpop"
    ? executeEnvironmentRequest<Group, A, E, R>(input).pipe(
        Effect.withSpan(ENVIRONMENT_REQUEST_SPAN, { root: true }),
        withRelayClientTracing,
      )
    : executeEnvironmentRequest<Group, A, E, R>(input).pipe(
        Effect.withSpan(ENVIRONMENT_REQUEST_SPAN),
      );
}

const ENVIRONMENT_REQUEST_SPAN = "clientRuntime.state.executeAuthenticatedEnvironmentHttpRequest";

const executeEnvironmentRequest = Effect.fnUntraced(function* <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(
  input: RequestOptions<A> & (GroupRequest<Group, A, E, R> | PathRequest<A, E, R>),
): Effect.fn.Return<
  A,
  RemoteEnvironmentRequestError,
  Effect.Services<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>> | R
> {
  let httpBaseUrl = input.prepared.httpBaseUrl;
  const requestUrlFor = (baseUrl: string) =>
    "urlForBase" in input
      ? input.urlForBase(baseUrl)
      : input.url(makeEnvironmentHttpApiUrlBuilder(baseUrl)[input.group]);
  return yield* Effect.gen(function* () {
    let rejectedAccessToken: string | undefined;
    for (;;) {
      let authorization = input.prepared.httpAuthorization;
      if (authorization?._tag === "Dpop") {
        const remote = input.remoteAuthorization;
        if (remote === undefined || Option.isNone(remote)) {
          return yield* new RemoteEnvironmentAuthFetchError({
            message: "No relay authorization service is available for the environment request.",
            cause: input.prepared.target._tag,
          });
        }
        const current = yield* remote.value
          .authorizeDpopHttp({
            expectedEnvironmentId: input.prepared.environmentId,
            ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RemoteEnvironmentAuthFetchError({
                  message: "Could not authorize the environment request.",
                  cause,
                }),
            ),
          );
        // A learned direct route keeps its own origin; only the token renews.
        if (input.prepared.target._tag === "RelayConnectionTarget") {
          httpBaseUrl = current.httpBaseUrl;
        }
        authorization = current.httpAuthorization;
      }

      const requestUrl = requestUrlFor(httpBaseUrl);
      const headers = yield* buildEnvironmentAuthHeaders(
        authorization,
        input.method,
        requestUrl,
        input.signer,
      );
      const request =
        "urlForBase" in input
          ? input.request({ headers })
          : input.request({
              client: yield* makeEnvironmentHttpApiGroupClient(httpBaseUrl, input.group),
              headers,
            });
      const result = yield* executeEnvironmentHttpRequest(
        requestUrl,
        input.timeoutMs,
        withEnvironmentCredentials(authorization, request),
      ).pipe(Effect.result);

      if (Result.isFailure(result)) {
        if (
          authorization?._tag === "Dpop" &&
          rejectedAccessToken === undefined &&
          result.failure._tag === "EnvironmentAuthInvalidError" &&
          result.failure.reason === "invalid_credential"
        ) {
          rejectedAccessToken = authorization.accessToken;
          continue;
        }
        return yield* result.failure;
      }

      if (
        authorization?._tag === "Dpop" &&
        input.isUnauthorizedResponse?.(result.success) === true
      ) {
        if (rejectedAccessToken === undefined) {
          rejectedAccessToken = authorization.accessToken;
          continue;
        }
        return yield* new RemoteEnvironmentAuthFetchError({
          message: "The environment rejected the renewed session authorization.",
          cause: result.success,
        });
      }
      return result.success;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.fail(
          new RemoteEnvironmentAuthTimeoutError(requestUrlFor(httpBaseUrl), input.timeoutMs),
        ),
    }),
  );
});
