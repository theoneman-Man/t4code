// @effect-diagnostics nodeBuiltinImport:off - Executable discovery must also work in provider callbacks without filesystem services.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

export const resolveCodexExecutable = Effect.fn("resolveCodexExecutable")(function* (
  binary: string,
  environment: NodeJS.ProcessEnv,
) {
  if ((yield* HostProcess.Platform) !== "win32" || !["codex", "codex.exe"].includes(binary))
    return binary;
  const local = Object.entries(environment).find(
    ([name]) => name.toUpperCase() === "LOCALAPPDATA",
  )?.[1];
  if (!local) return binary;
  // The desktop installer moves its native CLI between versioned directories.
  // A stale PATH launcher can still exist and fail with exit code 1.
  return yield* Effect.tryPromise(async () => {
    const root = NodePath.join(local, "OpenAI", "Codex", "bin");
    const entries = await NodeFSP.readdir(root);
    const candidates = await Promise.all(
      entries.map(async (entry) => {
        const executable = NodePath.join(root, entry, "codex.exe");
        try {
          const stat = await NodeFSP.stat(executable);
          return stat.isFile() ? { executable, modified: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
    );
    return (
      candidates
        .flatMap((entry) => (entry === null ? [] : [entry]))
        .sort((a, b) => b.modified - a.modified || a.executable.localeCompare(b.executable))[0]
        ?.executable ?? binary
    );
  }).pipe(Effect.orElseSucceed(() => binary));
});
