// @effect-diagnostics nodeBuiltinImport:off -- Command ids are host-generated and never supplied by extensions.
import * as NodeCrypto from "node:crypto";
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import * as Settings from "../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { ThreadOperations, ExtensionThreadError } from "./ThreadOperations.ts";

const unavailable = () => new ExtensionThreadError({ status: 503, reason: "unavailable" });
const make = Effect.gen(function* () {
  const projects = yield* Project.ProjectService;
  const folders = yield* ManagedFolders.ManagedProjectFolders;
  const settings = yield* Settings.ServerSettingsService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  return ThreadOperations.of({
    prepare: Effect.fn("ExtensionThreads.prepare")(function* (input) {
      const projectId =
        input.projectId === undefined
          ? (yield* folders.ensureScratchProject.pipe(Effect.mapError(unavailable))).projectId
          : ProjectId.make(input.projectId);
      const project = yield* projects.getById(projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new ExtensionThreadError({ status: 404, reason: "invalid_request" });
      const defaults = resolveProjectSettings(
        yield* settings.getSettings.pipe(Effect.mapError(unavailable)),
        projectId,
        project.value,
      ).settings;
      if (!defaults.defaultModelSelection)
        return yield* new ExtensionThreadError({ status: 400, reason: "invalid_request" });
      return { projectId, modelSelection: defaults.defaultModelSelection };
    }),
    launch: Effect.fn("ExtensionThreads.launchProvider")(function* (id, input, prepared) {
      yield* launches
        .launch({
          commandId: CommandId.make(id),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make(prepared.projectId),
          title: input.title,
          modelSelection: prepared.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "agent",
          creationSource: "mcp",
          initialMessage: {
            messageId: MessageId.make(id),
            text: input.instructions ? `${input.instructions}\n\n${input.prompt}` : input.prompt,
            attachments: [],
          },
        })
        .pipe(Effect.mapError(unavailable));
    }),
    send: Effect.fn("ExtensionThreads.sendProvider")(function* (id, text) {
      const threadId = ThreadId.make(id);
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      if (!shell || shell.deletedAt !== null)
        return yield* new ExtensionThreadError({ status: 404, reason: "not_owned" });
      const commandId = CommandId.make(`extension:${NodeCrypto.randomUUID()}`);
      yield* threads
        .sendToThread({
          commandId,
          threadId,
          projectId: shell.projectId,
          messageId: MessageId.make(commandId),
          text,
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(unavailable));
    }),
    read: Effect.fn("ExtensionThreads.readProvider")(function* (id, after) {
      if (
        after !== undefined &&
        (!/^(0|[1-9]\d*)$/.test(after) || !Number.isSafeInteger(Number(after)))
      )
        return yield* new ExtensionThreadError({ status: 400, reason: "invalid_request" });
      const threadId = ThreadId.make(id);
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      if (!shell || shell.deletedAt !== null)
        return yield* new ExtensionThreadError({ status: 404, reason: "not_owned" });
      const page = yield* threads
        .getTimelinePage(threadId, {
          limit: 100,
          view: "messages",
          ...(after === undefined ? {} : { afterPosition: Number(after) }),
        })
        .pipe(Effect.mapError(unavailable));
      return {
        threadId: id,
        status: shell.archivedAt !== null ? "archived" : shell.status,
        messages: page.items.flatMap(({ item }) =>
          item.type === "user_message" || item.type === "assistant_message"
            ? [
                {
                  id: item.messageId,
                  role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
                  text: item.text,
                  streaming: item.type === "assistant_message" && item.streaming,
                },
              ]
            : [],
        ),
        after: page.items.at(-1)?.position.toString() ?? after ?? null,
      };
    }),
    events: (id, after) =>
      threads.streamStoredEventsFrom({ threadId: ThreadId.make(id), afterSequence: after }).pipe(
        // Only invalidations leave the host. Provider/tool payloads can be large and stay in orchestration.
        Stream.map(({ sequence, event }) => ({
          topic: `thread:${id}`,
          cursor: String(sequence),
          data: { threadId: id, type: event.type },
        })),
        Stream.mapError(unavailable),
      ),
  });
});
export const layer = Layer.effect(ThreadOperations, make);
