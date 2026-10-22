import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { EnvironmentId } from "@t3tools/contracts";
import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { fetchEnvironmentExtensionHttp } from "./extensionHttp.ts";

function prepared(httpAuthorization: PreparedConnection["httpAuthorization"]): PreparedConnection {
  return {
    environmentId: EnvironmentId.make("env"),
    label: "Test",
    httpBaseUrl: "https://environment.example.test",
    socketUrl: "wss://environment.example.test/ws",
    httpAuthorization,
    target: new RelayConnectionTarget({ environmentId: EnvironmentId.make("env"), label: "Test" }),
  };
}

it.effect(
  "uses cookie credentials and streams after returning headers until caller cancellation",
  () => {
    const abort = new AbortController();
    return Effect.gen(function* () {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
        async (_url, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(value) {
                controller = value;
                init?.signal?.addEventListener("abort", () => value.error(init.signal?.reason), {
                  once: true,
                });
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const response = yield* fetchEnvironmentExtensionHttp(prepared(null), "/ext/sample/events", {
        signal: abort.signal,
      }).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch)));
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(false);
      const reader = response.body!.getReader();
      controller.enqueue(new TextEncoder().encode('event: tick\ndata: {"n":1}\n\n'));
      expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toBe(
        'event: tick\ndata: {"n":1}\n\n',
      );
      expect(fetch.mock.calls[0]![0]).toBe("https://environment.example.test/ext/sample/events");
      expect(fetch.mock.calls[0]![1]?.credentials).toBe("include");
      expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBeNull();
      abort.abort();
      yield* Effect.promise(() => expect(reader.read()).rejects.toThrow());
      reader.releaseLock();
      expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    });
  },
);

it.effect("uses the selected bearer and strips extension-supplied credential headers", () =>
  Effect.gen(function* () {
    using fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ message: "hello" }));
    yield* fetchEnvironmentExtensionHttp(
      prepared({ _tag: "Bearer", token: "fixture-bearer" }),
      "/ext/sample/hello",
      {
        headers: {
          authorization: "extension-value",
          dpop: "extension-proof",
          "content-type": "application/json",
        },
      },
    ).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch)));
    const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-bearer");
    expect(headers.get("dpop")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(fetch.mock.calls[0]![1]?.credentials).toBe("omit");
  }),
);

it.effect(
  "renews relay authorization and signs each actual extension URL before retrying a rejected token",
  () =>
    Effect.gen(function* () {
      using fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(Response.json({ message: "hello" }));
      const proofs: ManagedRelay.ManagedRelayDpopProofInput[] = [];
      const rejected: Array<string | undefined> = [];
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("fixture-thumbprint"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "fixture-proof";
          }),
      });
      const remote = RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("Unexpected bearer preparation"),
        authorizeDpop: () => Effect.die("Unexpected socket preparation"),
        authorizeDpopHttp: (input) =>
          Effect.sync(() => {
            rejected.push(input.rejectedAccessToken);
            return {
              environmentId: EnvironmentId.make("env"),
              label: "Test",
              httpBaseUrl: input.rejectedAccessToken
                ? "https://renewed.example.test"
                : "https://relay.example.test",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: input.rejectedAccessToken ? "renewed" : "current",
                expiresAtEpochMs: 3600000,
              },
            };
          }),
      });
      const response = yield* fetchEnvironmentExtensionHttp(
        prepared({ _tag: "Dpop", accessToken: "expired", expiresAtEpochMs: 0 }),
        "/ext/sample/hello?name=a%20b",
        { method: "POST" },
      ).pipe(
        Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, signer),
        Effect.provideService(RemoteEnvironmentAuthorization, remote),
        Effect.provide(layerRemoteHttpClient(globalThis.fetch)),
      );
      expect(response.status).toBe(200);
      expect(rejected).toEqual([undefined, "current"]);
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://relay.example.test/ext/sample/hello?name=a%20b",
          accessToken: "current",
        },
        {
          method: "POST",
          url: "https://renewed.example.test/ext/sample/hello?name=a%20b",
          accessToken: "renewed",
        },
      ]);
      expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("authorization")).toBe(
        "DPoP renewed",
      );
    }),
);
