// @effect-diagnostics nodeBuiltinImport:off -- Hashes make receipt paths independent of extension input.
import * as NodeCrypto from "node:crypto";
import {
  LaunchThreadInput,
  type ThreadMedia,
  type ThreadReadResult,
} from "@t3tools/extension-sdk/threads";
import type { ExtensionEvent } from "@t3tools/extension-sdk/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Operations from "./ThreadOperations.ts";

const Receipt = Schema.Struct({
  extensionId: Schema.String,
  fingerprint: Schema.String,
  input: LaunchThreadInput,
  prepared: Operations.PreparedLaunch,
  accepted: Schema.optional(Schema.Boolean),
});
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Receipt));
const decodeLaunch = Schema.decodeUnknownEffect(LaunchThreadInput);
const encodeLaunch = Schema.encodeEffect(Schema.fromJsonString(LaunchThreadInput));
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const unavailable = () =>
  new Operations.ExtensionThreadError({ status: 503, reason: "unavailable" });

export class ExtensionThreads extends Context.Service<
  ExtensionThreads,
  {
    readonly launchThread: (
      extensionId: string,
      input: LaunchThreadInput,
    ) => Effect.Effect<string, Operations.ExtensionThreadError>;
    readonly sendToThread: (
      extensionId: string,
      threadId: string,
      text: string,
      media?: ThreadMedia,
    ) => Effect.Effect<void, Operations.ExtensionThreadError>;
    readonly readThread: (
      extensionId: string,
      threadId: string,
      after?: string,
    ) => Effect.Effect<ThreadReadResult, Operations.ExtensionThreadError>;
    readonly subscribeThread: (
      extensionId: string,
      threadId: string,
      after: number,
    ) => Effect.Effect<
      Stream.Stream<ExtensionEvent, Operations.ExtensionThreadError>,
      Operations.ExtensionThreadError
    >;
  }
>()("t3/extensions/ExtensionThreads") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const operations = yield* Operations.ThreadOperations;
  const lock = yield* Semaphore.make(1);
  const directory = path.join(config.stateDir, "extension-threads");
  const receiptPath = (threadId: string) => path.join(directory, `${hash(threadId)}.json`);
  const load = Effect.fn("ExtensionThreads.loadReceipt")(function* (threadId: string) {
    const file = receiptPath(threadId);
    if (!(yield* fs.exists(file).pipe(Effect.mapError(unavailable)))) return undefined;
    const json = yield* fs.readFileString(file).pipe(Effect.mapError(unavailable));
    return yield* decodeReceipt(json).pipe(Effect.mapError(unavailable));
  });
  const assertOwned = Effect.fn("ExtensionThreads.assertOwned")(function* (
    extensionId: string,
    threadId: string,
  ) {
    const receipt = yield* load(threadId);
    if (!receipt || receipt.extensionId !== extensionId)
      return yield* new Operations.ExtensionThreadError({ status: 404, reason: "not_owned" });
  });
  const save = Effect.fn("ExtensionThreads.saveReceipt")(function* (
    threadId: string,
    receipt: typeof Receipt.Type,
  ) {
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(unavailable));
    const temporary = path.join(directory, `${NodeCrypto.randomUUID()}.tmp`);
    const encoded = yield* encodeReceipt(receipt).pipe(Effect.mapError(unavailable));
    yield* fs.writeFileString(temporary, encoded).pipe(Effect.mapError(unavailable));
    yield* fs.rename(temporary, receiptPath(threadId)).pipe(Effect.mapError(unavailable));
  });
  return ExtensionThreads.of({
    launchThread: Effect.fn("ExtensionThreads.launchThread")(function* (extensionId, rawInput) {
      const input = yield* decodeLaunch(rawInput).pipe(
        Effect.mapError(
          () => new Operations.ExtensionThreadError({ status: 400, reason: "invalid_request" }),
        ),
      );
      const id = `extension:${hash(`${extensionId}\0${input.idempotencyKey}`)}`;
      const fingerprint = hash(yield* encodeLaunch(input).pipe(Effect.mapError(unavailable)));
      const existing = yield* load(id);
      if (
        existing &&
        (existing.extensionId !== extensionId || existing.fingerprint !== fingerprint)
      )
        return yield* new Operations.ExtensionThreadError({ status: 409, reason: "key_conflict" });
      if (existing?.accepted) return id;
      const receipt = existing ?? {
        extensionId,
        fingerprint,
        input,
        prepared: yield* operations.prepare(input),
      };
      if (!existing) {
        // Persist the chosen defaults before dispatch, so retry after a crash uses the same command.
        yield* save(id, receipt);
      }
      yield* operations.launch(id, receipt.input, receipt.prepared, extensionId);
      yield* save(id, { ...receipt, accepted: true });
      return id;
    }, lock.withPermit),
    sendToThread: Effect.fn("ExtensionThreads.sendToThread")(
      function* (extensionId, threadId, text, media) {
        yield* assertOwned(extensionId, threadId);
        yield* operations.send(threadId, text, media, extensionId);
      },
    ),
    readThread: Effect.fn("ExtensionThreads.readThread")(function* (extensionId, threadId, after) {
      yield* assertOwned(extensionId, threadId);
      return yield* operations.read(threadId, after);
    }),
    subscribeThread: Effect.fn("ExtensionThreads.subscribeThread")(
      function* (extensionId, threadId, after) {
        yield* assertOwned(extensionId, threadId);
        return operations.events(threadId, after);
      },
    ),
  });
});
export const layer = Layer.effect(ExtensionThreads, make);
