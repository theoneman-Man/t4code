import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import { makeHarness } from "../updates/updatesTestHarness.ts";
import * as ExtensionUpdates from "./updates.ts";

it.effect.each(["none", "error", "throw", "event", "resume-error"] as const)(
  "update install stops extensions once and recovers on %s",
  (failure) => {
    const steps: string[] = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        steps.push("server-stop");
      }),
      startBackend: Effect.sync(() => {
        steps.push("server-start");
      }),
      quitAndInstall: Effect.suspend(() => {
        steps.push("install");
        if (failure === "error")
          return Effect.fail(
            new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              channel: "latest",
              isSilent: true,
              isForceRunAfter: true,
              cause: new Error("refused"),
            }),
          );
        if (failure === "throw" || failure === "resume-error") throw new Error("refused");
        return Effect.void;
      }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        yield* ExtensionUpdates.register(shutdown, {
          suspend: Effect.sync(() => {
            steps.push("extension-stop");
          }),
          resume: Effect.sync(() => {
            steps.push("extension-start");
            if (failure === "resume-error") throw new Error("extension refused");
          }),
        });
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const subscription = yield* updates.subscribe;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* subscription.changes.pipe(
          Stream.filter((state) => state.downloadedVersion === "1.2.4"),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* updates.install;
        if (failure === "event") {
          const recovery = yield* updates.subscribe;
          harness.emit("error", new Error("refused"));
          yield* recovery.changes.pipe(
            Stream.filter((state) => state.errorContext === "install"),
            Stream.take(1),
            Stream.runDrain,
          );
        }
        expect(steps).toEqual(
          failure === "none"
            ? ["server-stop", "extension-stop", "install"]
            : ["server-stop", "extension-stop", "install", "extension-start", "server-start"],
        );
        if (failure === "none") expect((yield* updates.install).accepted).toBe(false);
        expect(steps.filter((step) => step === "extension-stop")).toHaveLength(1);
      }),
    ).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(DesktopShutdown.layer))));
  },
);

it.effect("extension update registration is scoped and stop/recovery are idempotent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const shutdown = yield* DesktopShutdown.DesktopShutdown;
      const updates = yield* ExtensionUpdates.make;
      const steps: string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ExtensionUpdates.register(shutdown, {
            suspend: Effect.sync(() => {
              steps.push("stop");
            }),
            resume: Effect.sync(() => {
              steps.push("start");
            }),
          });
          yield* updates.stop;
          yield* updates.stop;
          yield* updates.recover;
          yield* updates.recover;
          yield* updates.stop;
          yield* updates.recover;
        }),
      );
      yield* updates.stop;
      expect(steps).toEqual(["stop", "start", "stop", "start"]);
    }),
  ).pipe(Effect.provide(DesktopShutdown.layer)),
);
