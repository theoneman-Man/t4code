// @effect-diagnostics nodeBuiltinImport:off -- Development-only Node watcher and process boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeTimers from "node:timers";

const ignored = new Set(["node_modules", ".git", ".t3", ".vite-plus", "dist", "dist-electron"]);

export function sourceSnapshot(roots: readonly string[]) {
  const fingerprints = new Map<string, string>();
  const scan = (path: string, next: Map<string, string>) => {
    if (path.split(NodePath.sep).some((part) => ignored.has(part))) return;
    if (path.endsWith(".tsbuildinfo")) return;
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isDirectory()) {
      for (const name of NodeFS.readdirSync(path)) scan(NodePath.join(path, name), next);
    } else if (stat.isFile()) {
      next.set(
        path,
        NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex"),
      );
    }
  };
  const refresh = (path: string) => {
    const next = new Map<string, string>();
    scan(path, next);
    let changed = false;
    for (const [file, hash] of fingerprints) {
      if (file !== path && !file.startsWith(path + NodePath.sep)) continue;
      if (next.get(file) !== hash) changed = true;
      if (!next.has(file)) fingerprints.delete(file);
    }
    for (const [file, hash] of next) {
      if (fingerprints.get(file) !== hash) changed = true;
      fingerprints.set(file, hash);
    }
    return changed;
  };
  for (const root of roots) scan(root, fingerprints);
  return { refresh };
}

export function watchServer(entry: string, args: readonly string[]) {
  const roots = ["src", "../../packages", "package.json"].map((path) => NodePath.resolve(path));
  const pending = new Set<string>();
  let timer: ReturnType<typeof NodeTimers.setTimeout> | undefined;
  let snapshot: ReturnType<typeof sourceSnapshot>;
  let child: NodeChildProcess.ChildProcess;
  let stopping = false;
  let restarting = false;
  const start = () => {
    restarting = false;
    child = NodeChildProcess.spawn(process.execPath, [entry, ...args], { stdio: "inherit" });
    child.on("error", (error) => {
      process.stderr.write(String(error) + "\n");
      stop();
      process.exitCode = 1;
    });
    child.on("exit", () => {
      if (restarting && !stopping) start();
    });
  };
  const flush = () => {
    timer = undefined;
    let changed = false;
    for (const path of pending) changed = snapshot.refresh(path) || changed;
    pending.clear();
    if (!changed || stopping || restarting) return;
    process.stdout.write("Source content changed; restarting server.\n");
    if (child.exitCode !== null || child.signalCode !== null) start();
    else {
      restarting = true;
      child.kill("SIGTERM");
    }
  };
  const watchers = roots.map((root) => {
    const directory = NodeFS.statSync(root).isDirectory();
    return NodeFS.watch(root, { recursive: directory }, (_event, filename) => {
      const path = directory && filename ? NodePath.join(root, filename) : root;
      if (path.split(NodePath.sep).some((part) => ignored.has(part))) return;
      pending.add(path);
      if (timer) NodeTimers.clearTimeout(timer);
      // @effect-diagnostics-next-line globalTimers:off -- Debounce native filesystem callbacks outside the Effect runtime.
      timer = NodeTimers.setTimeout(flush, 100);
    });
  });
  // Windows can emit change events when a read updates an old access time. Compare bytes,
  // including the initial read's events, before deciding to replace the running server.
  snapshot = sourceSnapshot(roots);
  const stop = () => {
    stopping = true;
    for (const watcher of watchers) watcher.close();
    if (timer) NodeTimers.clearTimeout(timer);
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  start();
  return stop;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  watchServer(process.argv[2] ?? "src/bin.ts", process.argv.slice(3));
}
