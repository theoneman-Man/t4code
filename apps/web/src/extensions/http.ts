import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { fetchEnvironmentExtensionHttp } from "@t3tools/client-runtime/state/extension-http";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "../state/session";

class ExtensionConnectionTimeout extends Data.TaggedError("ExtensionConnectionTimeout") {
  override readonly message = "Extension environment connection was not ready within 30 seconds.";
}

export function extensionPath(id: string, path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path))
    throw new Error("Extension paths must be absolute backend paths.");
  const prefix = `/ext/${encodeURIComponent(id)}`;
  const url = new URL(`${prefix}${path}`, "http://extension.invalid");
  if (!url.pathname.startsWith(`${prefix}/`))
    throw new Error("Extension path escapes its backend.");
  return `${url.pathname}${url.search}`;
}

export async function fetchEnvironmentPath(
  environmentId: string,
  path: string,
  init: RequestInit = {},
) {
  const id = EnvironmentId.make(environmentId);
  const result = Effect.scoped(
    Effect.gen(function* () {
      const prepared = yield* AtomRegistry.toStream(
        appAtomRegistry,
        environmentSession.preparedConnectionValueAtom(id),
      ).pipe(
        Stream.filter(Option.isSome),
        Stream.map((value) => value.value),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () => Effect.never,
          }),
        ),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(new ExtensionConnectionTimeout()),
        }),
      );
      const atom = connectionAtomRuntime.atom(fetchEnvironmentExtensionHttp(prepared, path, init));
      yield* AtomRegistry.mount(appAtomRegistry, atom);
      return yield* AtomRegistry.getResult(appAtomRegistry, atom);
    }),
  );
  return Effect.runPromise(result, init.signal ? { signal: init.signal } : undefined);
}
