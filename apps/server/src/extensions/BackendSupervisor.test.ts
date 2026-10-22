// @effect-diagnostics nodeBuiltinImport:off -- Tests model captured child handles without spawning a process.
import * as NodeChildProcess from "node:child_process";
import { vi } from "vite-plus/test";
import { stopChild } from "@t3tools/extension-sdk/host";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { READY_STABILITY_MS, supervise } from "@t3tools/extension-sdk/host";

vi.mock("node:child_process", { spy: true });

const harness = Effect.fn("SupervisorTest.harness")(function* (ready = true) {
  const launches = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const states = yield* Queue.unbounded<"restarting" | "failed">();
  let launchCount = 0;
  const fiber = yield* supervise(
    (onReady) =>
      Effect.gen(function* () {
        launchCount++;
        const exit = yield* Deferred.make<void>();
        if (ready) yield* onReady;
        yield* Queue.offer(launches, exit);
        yield* Deferred.await(exit);
        if (!ready) return yield* Effect.fail("readiness failed");
      }),
    (state) => Queue.offer(states, state).pipe(Effect.asVoid),
  ).pipe(Effect.forkScoped);
  return {
    launches,
    states,
    fiber,
    count: () => launchCount,
    crash: Effect.gen(function* () {
      const exit = yield* Queue.take(launches);
      yield* Deferred.succeed(exit, undefined);
      return yield* Queue.take(states);
    }),
  };
});

it.effect.each([true, false])("stops after five consecutive restarts, ready=%s", (ready) =>
  Effect.gen(function* () {
    const test = yield* harness(ready);
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      if (!ready) {
        const exit = yield* Queue.take(test.launches);
        yield* TestClock.adjust(READY_STABILITY_MS);
        yield* Deferred.succeed(exit, undefined);
        expect(yield* Queue.take(test.states)).toBe("restarting");
      } else {
        expect(yield* test.crash).toBe("restarting");
      }
      yield* TestClock.adjust(delay);
    }
    expect(yield* test.crash).toBe("failed");
    yield* Fiber.join(test.fiber);
    expect(test.count()).toBe(6);
  }),
);

it.effect("does not recover just before the ready stability window", () =>
  Effect.gen(function* () {
    const test = yield* harness();
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      expect(yield* test.crash).toBe("restarting");
      yield* TestClock.adjust(delay);
    }
    const exit = yield* Queue.take(test.launches);
    yield* TestClock.adjust(READY_STABILITY_MS - 1);
    yield* Deferred.succeed(exit, undefined);
    expect(yield* Queue.take(test.states)).toBe("failed");
    yield* Fiber.join(test.fiber);
    expect(test.count()).toBe(6);
  }),
);

it.effect("recovers the restart budget and initial backoff after a stable ready launch", () =>
  Effect.gen(function* () {
    const test = yield* harness();
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      expect(yield* test.crash).toBe("restarting");
      yield* TestClock.adjust(delay);
    }
    // Take this launch before advancing time so only time spent ready can recover the budget.
    const stableExit = yield* Queue.take(test.launches);
    yield* TestClock.adjust(READY_STABILITY_MS);
    yield* Deferred.succeed(stableExit, undefined);
    expect(yield* Queue.take(test.states)).toBe("restarting");
    yield* TestClock.adjust(250);
    expect(yield* test.crash).toBe("restarting");
    yield* TestClock.adjust(500);
    for (const delay of [1000, 2000, 4000]) {
      expect(yield* test.crash).toBe("restarting");
      yield* TestClock.adjust(delay);
    }
    expect(yield* test.crash).toBe("failed");
    yield* Fiber.join(test.fiber);
    expect(test.count()).toBe(11);
  }),
);

it.live(
  "Windows shutdown targets the captured PID tree and waits for the owned child to close",
  () =>
    Effect.gen(function* () {
      const child = Object.assign(new NodeChildProcess.ChildProcess(), { pid: 12345 });
      const killer = new NodeChildProcess.ChildProcess();
      const started = Promise.withResolvers<void>();
      const exited = Promise.withResolvers<void>();
      using kill = vi.spyOn(child, "kill").mockReturnValue(true);
      const spawn = vi.mocked(NodeChildProcess.spawn).mockImplementationOnce(() => {
        started.resolve();
        return killer;
      });
      let stopped = false;
      const stopping = yield* stopChild(child, exited.promise, "win32").pipe(
        Effect.andThen(
          Effect.sync(() => {
            stopped = true;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => started.promise);
      expect(spawn).toHaveBeenCalledWith("taskkill", ["/PID", "12345", "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      expect(kill).not.toHaveBeenCalled();
      killer.emit("exit", 0);
      expect(kill).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
      exited.resolve();
      yield* Fiber.join(stopping);
      expect(stopped).toBe(true);
    }),
);
