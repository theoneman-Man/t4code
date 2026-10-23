import { expect, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Management from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Settings from "../serverSettings.ts";
import * as Operations from "./ThreadOperations.ts";
import * as Live from "./ThreadOperationsLive.ts";

it.effect(
  "delegates launch to orchestration with fixed approval mode and no provider-specific work",
  () => {
    const received: Launch.ThreadLaunchInput[] = [];
    return Effect.gen(function* () {
      const service = yield* Operations.ThreadOperations;
      const input = {
        title: "Manager",
        prompt: "Inspect",
        instructions: "Ask a person",
        idempotencyKey: "one",
      };
      const prepared = {
        projectId: "project",
        modelSelection: { instanceId: ProviderInstanceId.make("fake"), model: "fake-model" },
      };
      const error = yield* Effect.flip(service.launch("owned", input, prepared));
      expect(error.reason).toBe("unavailable");
      expect(received).toEqual([
        {
          commandId: "owned",
          threadId: "owned",
          projectId: "project",
          title: "Manager",
          modelSelection: prepared.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "agent",
          creationSource: "mcp",
          initialMessage: { messageId: "owned", text: "Ask a person\n\nInspect", attachments: [] },
        },
      ]);
      const absent = yield* Effect.flip(service.prepare({ ...input, projectId: "missing" }));
      expect(absent.status).toBe(404);
      expect((yield* Effect.flip(service.read("missing"))).status).toBe(404);
      expect((yield* Effect.flip(service.read("missing", "-1"))).status).toBe(400);
      expect((yield* Effect.flip(service.send("missing", "Wake"))).status).toBe(404);
      expect(yield* service.events("owned", 17).pipe(Stream.runCollect)).toEqual([]);
    }).pipe(
      Effect.provide(
        Live.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Launch.ThreadLaunchService, {
                launch: (input) =>
                  Effect.gen(function* () {
                    received.push(input);
                    return yield* new Launch.ThreadLaunchError({
                      operation: "create-thread",
                      commandId: CommandId.make("owned"),
                      projectId: ProjectId.make("project"),
                      cause: "fake stop before provider",
                    });
                  }),
              }),
              Layer.mock(Management.ThreadManagementService, {
                getThreadShell: () => Effect.succeed(null),
                streamStoredEventsFrom: (input) => {
                  expect(input).toEqual({ threadId: ThreadId.make("owned"), afterSequence: 17 });
                  return Stream.empty;
                },
              }),
              Layer.mock(Projects.ProjectService, { getById: () => Effect.succeed(Option.none()) }),
              Layer.mock(Folders.ManagedProjectFolders, { namedProjectsRoot: "unused" }),
              Layer.mock(Settings.ServerSettingsService, {}),
            ),
          ),
        ),
      ),
    );
  },
);
