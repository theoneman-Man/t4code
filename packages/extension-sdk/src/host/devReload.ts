// @effect-diagnostics nodeBuiltinImport:off -- Development-only native filesystem and timer boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { EXTENSION_BUSY_PATH, type ExtensionBackendBusy } from "../protocol.ts";

const rootData = new Set(["runs", "artifacts", "outputs"]);
const ignored = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "build",
  "coverage",
  ".cache",
  ".t3",
  ".t4",
  ".vite",
  ".vite-plus",
  "data",
  "userdata",
  "logs",
  "tmp",
  "temp",
]);

export function isBackendSource(file: string, patterns?: readonly string[], dataPath?: string) {
  const relative = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    rootData.has(relative.split("/")[0]!) ||
    relative.split("/").some((part) => ignored.has(part)) ||
    /\.(?:tsbuildinfo|log|sqlite(?:-(?:wal|shm))?|db(?:-(?:wal|shm))?)$/i.test(relative)
  )
    return false;
  if (dataPath && (relative === dataPath || relative.startsWith(dataPath + "/"))) return false;
  return (
    patterns === undefined ||
    patterns.some((pattern) => {
      const normalized = pattern.replace(/^\.\//, "").replace(/\/$/, "") || ".";
      return (
        normalized === "." ||
        relative === normalized ||
        relative.startsWith(normalized + "/") ||
        NodePath.matchesGlob(relative, normalized)
      );
    })
  );
}

export function createReloadController(options: {
  readonly busy: () => Promise<ExtensionBackendBusy>;
  readonly reload: (changedFiles: number) => void;
  readonly log: (message: string) => void;
}) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let closed = false,
    checking = false,
    deferred = false;
  const schedule = (delay: number) => {
    // @effect-diagnostics-next-line globalTimers:off -- Native watcher callbacks do not run inside Effect.
    timer = globalThis.setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  };
  const flush = async () => {
    if (closed || checking || !pending.size) return;
    checking = true;
    let status: ExtensionBackendBusy;
    try {
      status = await options.busy();
    } catch {
      status = { busy: true, reason: "backend busy probe unavailable" };
    }
    checking = false;
    if (closed) return;
    if (status.busy) {
      if (!deferred) options.log(`reload deferred: ${status.reason ?? "backend busy"}`);
      deferred = true;
      schedule(3_000);
      return;
    }
    closed = true;
    options.log(`reloading backend (${pending.size} changed files)`);
    options.reload(pending.size);
  };
  return {
    changed(file: string) {
      if (closed) return;
      pending.add(file);
      if (deferred || checking) return;
      if (timer) globalThis.clearTimeout(timer);
      schedule(750);
    },
    close() {
      closed = true;
      if (timer) globalThis.clearTimeout(timer);
    },
  };
}

/** A launch owns its watcher, so packaged and borrowed backends never subscribe. */
export function watchBackendSources(options: {
  readonly development: boolean;
  readonly root: string;
  readonly dataDir: string;
  readonly patterns?: readonly string[];
  readonly busy: () => Promise<ExtensionBackendBusy>;
  readonly reload: (changedFiles: number) => void;
  readonly log: (message: string) => void;
}) {
  if (!options.development || NodePath.resolve(options.root) === NodePath.resolve(options.dataDir))
    return { close() {} };
  const dataPath = NodePath.relative(options.root, options.dataDir).replaceAll("\\", "/");
  const accepted = (file: string) => isBackendSource(file, options.patterns, dataPath);
  const fingerprints = new Map<string, string>();
  const scan = (relative: string, result: Map<string, string>) => {
    if (
      rootData.has(relative.split("/")[0]!) ||
      relative.split("/").some((part) => ignored.has(part))
    )
      return;
    if (dataPath && (relative === dataPath || relative.startsWith(dataPath + "/"))) return;
    const absolute = NodePath.join(options.root, relative);
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(absolute);
    } catch {
      return;
    }
    // Never follow symlinks into generated data or another workspace.
    if (stat.isDirectory()) {
      let names: string[];
      try {
        names = NodeFS.readdirSync(absolute);
      } catch {
        return;
      }
      for (const name of names) scan(relative ? relative + "/" + name : name, result);
    } else if (stat.isFile() && accepted(relative)) {
      try {
        result.set(
          relative,
          NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(absolute)).digest("hex"),
        );
      } catch {
        return;
      }
    }
  };
  const controller = createReloadController(options);
  scan("", fingerprints);
  const watcher = NodeFS.watch(options.root, { recursive: true }, (_event, filename) => {
    const relative = filename?.toString().replaceAll("\\", "/") ?? "";
    if (
      rootData.has(relative.split("/")[0]!) ||
      relative.split("/").some((part) => ignored.has(part))
    )
      return;
    if (dataPath && (relative === dataPath || relative.startsWith(dataPath + "/"))) return;
    const next = new Map<string, string>();
    scan(relative, next);
    for (const [file, hash] of fingerprints) {
      if (relative && file !== relative && !file.startsWith(relative + "/")) continue;
      if (next.get(file) !== hash) controller.changed(file);
      if (!next.has(file)) fingerprints.delete(file);
    }
    for (const [file, hash] of next) {
      if (fingerprints.get(file) !== hash) controller.changed(file);
      fingerprints.set(file, hash);
    }
  });
  watcher.on("error", () => options.log("backend source watcher failed"));
  return {
    close() {
      watcher.close();
      controller.close();
    },
  };
}

/** Only 404/405 mean the optional endpoint is absent. A broken probe must not interrupt work. */
export async function probeBackendBusy(descriptor: {
  readonly url: string;
  readonly token: string;
}): Promise<ExtensionBackendBusy> {
  // @effect-diagnostics-next-line globalFetch:off -- The native watcher probes outside the Effect runtime.
  const response = await fetch(`${descriptor.url}${EXTENSION_BUSY_PATH}`, {
    headers: { authorization: `Bearer ${descriptor.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  });
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel();
    return { busy: false };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Busy probe failed");
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("busy" in body) ||
    typeof body.busy !== "boolean"
  )
    throw new Error("Invalid busy response");
  return {
    busy: body.busy,
    ...("reason" in body && typeof body.reason === "string" ? { reason: body.reason } : {}),
  };
}
