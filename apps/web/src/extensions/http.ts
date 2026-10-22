import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { fetchEnvironmentExtensionHttp } from "@t3tools/client-runtime/state/extension-http";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { connectionAtomRuntime } from "../connection/runtime";
import { readPreparedConnection } from "../state/session";

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
  const prepared = readPreparedConnection(id);
  if (!prepared) throw new Error("Connect to the extension's environment first.");
  const atom = connectionAtomRuntime.atom(fetchEnvironmentExtensionHttp(prepared, path, init));
  const result = Effect.scoped(
    Effect.gen(function* () {
      yield* AtomRegistry.mount(appAtomRegistry, atom);
      return yield* AtomRegistry.getResult(appAtomRegistry, atom);
    }),
  );
  return Effect.runPromise(result, init.signal ? { signal: init.signal } : undefined);
}
