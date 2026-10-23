import { ModelSelection } from "@t3tools/contracts";
import type { LaunchThreadInput, ThreadReadResult } from "@t3tools/extension-sdk/threads";
import type { ExtensionEvent } from "@t3tools/extension-sdk/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class ExtensionThreadError extends Schema.TaggedError<ExtensionThreadError>()(
  "ExtensionThreadError",
  {
    status: Schema.Literals([400, 403, 404, 409, 503]),
    reason: Schema.Literals([
      "invalid_request",
      "permission_required",
      "not_owned",
      "key_conflict",
      "unavailable",
    ]),
  },
) {}

export const PreparedLaunch = Schema.Struct({
  projectId: Schema.String,
  modelSelection: ModelSelection,
});
export type PreparedLaunch = typeof PreparedLaunch.Type;

export class ThreadOperations extends Context.Service<
  ThreadOperations,
  {
    readonly prepare: (
      input: LaunchThreadInput,
    ) => Effect.Effect<PreparedLaunch, ExtensionThreadError>;
    readonly launch: (
      id: string,
      input: LaunchThreadInput,
      prepared: PreparedLaunch,
    ) => Effect.Effect<void, ExtensionThreadError>;
    readonly send: (id: string, text: string) => Effect.Effect<void, ExtensionThreadError>;
    readonly read: (
      id: string,
      after?: string,
    ) => Effect.Effect<ThreadReadResult, ExtensionThreadError>;
    readonly events: (
      id: string,
      after: number,
    ) => Stream.Stream<ExtensionEvent, ExtensionThreadError>;
  }
>()("t3/extensions/ThreadOperations") {}
