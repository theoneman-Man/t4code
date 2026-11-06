// @effect-diagnostics nodeBuiltinImport:off -- Resolve the generic extension fixture, never a private extension.
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Config from "../config.ts";
import * as Host from "./ExtensionHost.ts";
import * as Threads from "./ExtensionThreads.ts";
import * as Operations from "./ThreadOperations.ts";
import * as ThreadHttp from "./threadsHttp.ts";
import * as ExtensionHttp from "./http.ts";
import type { LaunchThreadInput } from "@t3tools/extension-sdk/threads";

it.live(
  "scopes fixture launch/read/send/events to its bearer and preserves launch receipts across restart",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "threads-",
      });
      const fixture = NodeURL.fileURLToPath(
        new URL("../../../../packages/extension-sdk/fixtures/sample", import.meta.url),
      );
      const unprivileged = path.join(directory, "unprivileged");
      yield* fs.makeDirectory(unprivileged);
      yield* fs.writeFileString(
        path.join(unprivileged, "t4-extension.json"),
        '{"id":"unprivileged","sdk":1}',
      );
      yield* fs.writeFileString(
        path.join(directory, "t4.extensions.json"),
        JSON.stringify([{ path: fixture, dataDir: path.join(directory, "fixture") }, unprivileged]),
      );
      const launched = new Map<string, LaunchThreadInput>();
      const sent: string[] = [];
      let prepares = 0;
      let launches = 0;
      let failNext = false;
      const operations = Operations.ThreadOperations.of({
        prepare: () =>
          Effect.sync(() => {
            prepares++;
            return {
              projectId: "project",
              modelSelection: { instanceId: ProviderInstanceId.make("fake"), model: "fake-model" },
            };
          }),
        launch: (id, input) =>
          Effect.gen(function* () {
            launches++;
            if (failNext) {
              failNext = false;
              return yield* new Operations.ExtensionThreadError({
                status: 503,
                reason: "unavailable",
              });
            }
            launched.set(id, input);
          }),
        send: (id, text) =>
          Effect.sync(() => {
            sent.push(`${id}:${text}`);
          }),
        read: (id, after) =>
          Effect.succeed({ threadId: id, status: "idle", messages: [], after: after ?? null }),
        events: (id, after) =>
          Stream.make({
            topic: `thread:${id}`,
            cursor: String(after + 1),
            data: { threadId: id, type: "message.updated" },
          }),
      });
      const config = Config.layerTest(directory, path.join(directory, "home"));
      const threadLayer = Threads.layer.pipe(
        Layer.provide(Layer.succeed(Operations.ThreadOperations, operations)),
      );
      const dependencies = Layer.mergeAll(
        threadLayer,
        Host.layerWithOptions({ hostRoot: directory }).pipe(Layer.provide(FetchHttpClient.layer)),
        EnvironmentAuth.layer.pipe(
          Layer.provide(Sqlite.layerMemory),
          Layer.provide(SecretStore.layer),
          Layer.provide(Environment.layerIdentity),
        ),
      ).pipe(Layer.provideMerge(config), Layer.provideMerge(NodeServices.layer));
      const services = yield* Layer.build(
        HttpRouter.serve(
          Layer.merge(
            ThreadHttp.layer,
            ExtensionHttp.layer.pipe(Layer.provide(FetchHttpClient.layer)),
          ),
          { disableLogger: true, disableListenLog: true },
        ).pipe(Layer.provideMerge(dependencies), Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      const host = Context.get(services, Host.ExtensionHost);
      const service = Context.get(services, Threads.ExtensionThreads);
      const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
      yield* host.awaitState("sample", "ready");
      const descriptor = yield* host.backend("sample");
      if (!descriptor) return yield* Effect.die("Fixture missing");
      const operate = yield* auth.issueSession({
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      });
      const read = yield* auth.issueSession({ scopes: [AuthOrchestrationReadScope] });
      const input = {
        title: "Manager",
        prompt: "Inspect fake work",
        instructions: "Require human approvals",
        idempotencyKey: "first",
      };
      const root = "/ext/sample/.t4/threads";
      const post = (url: string, token: string, body: unknown) =>
        client.execute(
          HttpClientRequest.post(url, { headers: { authorization: `Bearer ${token}` } }).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        );
      expect((yield* post(root, read.token, input)).status).toBe(403);
      expect((yield* post(root, "wrong", input)).status).toBe(401);
      expect((yield* post("/ext/unprivileged/.t4/threads", operate.token, input)).status).toBe(403);
      expect((yield* post("/ext/unprivileged/.t4/threads", descriptor.token, input)).status).toBe(
        401,
      );
      const response = yield* post(root, operate.token, input);
      expect(response.status).toBe(200);
      const id = yield* service.launchThread("sample", input);
      expect(yield* response.json).toEqual({ threadId: id });
      const ids = yield* Effect.all(
        [service.launchThread("sample", input), service.launchThread("sample", input)],
        { concurrency: "unbounded" },
      );
      expect(ids).toEqual([id, id]);
      expect(prepares).toBe(1);
      expect(launched.size).toBe(1);
      expect(launches).toBe(1);
      expect((yield* post(root, operate.token, { ...input, prompt: "Changed" })).status).toBe(409);
      expect(
        (yield* post(root, operate.token, { ...input, runtimeMode: "auto-accept-edits" })).status,
      ).toBe(409);
      expect(
        (yield* post(root, operate.token, {
          ...input,
          idempotencyKey: "unrestricted",
          runtimeMode: "full-access",
        })).status,
      ).toBe(400);
      expect((yield* post(root, operate.token, { ...input, prompt: "" })).status).toBe(400);
      const backendAuth = { authorization: `Bearer ${descriptor.token}` };
      const owned = `${root}/${encodeURIComponent(id)}`;
      const readResponse = yield* client.get(`${owned}?after=7`, { headers: backendAuth });
      expect(yield* readResponse.json).toEqual({
        threadId: id,
        status: "idle",
        messages: [],
        after: "7",
      });
      expect(
        (yield* post(`${owned}/messages`, descriptor.token, { text: "Wake from event" })).status,
      ).toBe(200);
      expect(sent).toEqual([`${id}:Wake from event`]);
      expect(
        (yield* post(`${root}/foreign/messages`, descriptor.token, { text: "Denied" })).status,
      ).toBe(404);
      expect((yield* client.get(`${root}/foreign/events`, { headers: backendAuth })).status).toBe(
        404,
      );
      expect(
        (yield* client.get(`${owned}/events?cursor=-1`, { headers: backendAuth })).status,
      ).toBe(400);
      const events = yield* client.get(`${owned}/events?cursor=7`, { headers: backendAuth });
      expect(yield* events.text).toContain(`id: 8\nevent: thread:${id}`);
      const denied = yield* Effect.flip(service.readThread("another", id));
      expect(denied.reason).toBe("not_owned");
      const restarted = yield* Layer.build(
        threadLayer.pipe(Layer.provide(config), Layer.provide(NodeServices.layer)),
      );
      expect(
        yield* Context.get(restarted, Threads.ExtensionThreads).launchThread("sample", input),
      ).toBe(id);
      expect(prepares).toBe(1);
      // The ordinary fixture proxy still works alongside the reserved host paths.
      expect(launches).toBe(1);
      failNext = true;
      const recovery = { ...input, idempotencyKey: "recovery" };
      expect((yield* post(root, operate.token, recovery)).status).toBe(503);
      const recoveredId = yield* service.launchThread("sample", recovery);
      expect(recoveredId).not.toBe(id);
      expect(prepares).toBe(2);
      expect(launches).toBe(3);
      const hello = yield* client.get("/ext/sample/hello", {
        headers: { authorization: `Bearer ${read.token}` },
      });
      expect(yield* hello.json).toEqual({ message: "hello from sample" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
