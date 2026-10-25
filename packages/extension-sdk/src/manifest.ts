// Build-time extension manifest (`t4-extension.json`) and host list (`t4.extensions.json`).
// Pure: safe to import from the browser, the server and build tooling.

export const EXTENSION_SDK_VERSION = 1;
export const EXTENSION_BACKEND_PROTOCOL = 1;
export const EXTENSION_MANIFEST_FILE = "t4-extension.json";
export const EXTENSION_LIST_FILE = "t4.extensions.json";

export type ExtensionRouteScope = "read" | "operate";
export type ExtensionRouteMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";

export interface ExtensionRoute {
  readonly method: ExtensionRouteMethod;
  /** Starts with `/`. `*` matches one path segment, a trailing `/**` matches any remainder. */
  readonly path: string;
  readonly scope: ExtensionRouteScope;
}

export interface ExtensionBackendManifest {
  readonly command: readonly [string, ...string[]];
  /** Relative to the extension folder. */
  readonly cwd: string;
  readonly protocol: typeof EXTENSION_BACKEND_PROTOCOL;
  /** Default data directory; a host list entry may override it. */
  readonly dataDir?: string;
  /** Development source selection, relative to the extension root. Defaults to the whole folder. */
  readonly watch?: readonly string[];
}

export interface ExtensionManifest {
  readonly permissions?: readonly "threads"[];
  readonly id: string;
  readonly sdk: typeof EXTENSION_SDK_VERSION;
  /** Web entry relative to the extension folder; its default export is an `ExtensionModule`. */
  readonly web?: string;
  readonly backend?: ExtensionBackendManifest;
  /** Ordered: the first matching route decides the scope. Unmatched requests are not proxied. */
  readonly routes: readonly ExtensionRoute[];
}

/** One entry of `t4.extensions.json`: a folder path, or a folder plus host-local overrides. */
export interface ExtensionListEntry {
  readonly path: string;
  readonly dataDir?: string;
}

export class ExtensionManifestError extends Error {
  override readonly name = "ExtensionManifestError";
}

const EXTENSION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "*",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function isValidExtensionId(id: string): boolean {
  return EXTENSION_ID.test(id);
}

function parseRoute(value: unknown, source: string, index: number): ExtensionRoute {
  const where = `${source}: routes[${index}]`;
  if (!isRecord(value)) throw new ExtensionManifestError(`${where} must be an object`);
  const method = typeof value.method === "string" ? value.method.toUpperCase() : "";
  if (!METHODS.has(method)) throw new ExtensionManifestError(`${where}.method is not supported`);
  const path = value.path;
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("..")) {
    throw new ExtensionManifestError(`${where}.path must start with "/" and not contain ".."`);
  }
  const doubleStar = path.indexOf("**");
  if (doubleStar !== -1 && (doubleStar !== path.length - 2 || !path.endsWith("/**"))) {
    throw new ExtensionManifestError(`${where}.path may use "**" only as a final "/**" segment`);
  }
  if (value.scope !== "read" && value.scope !== "operate") {
    throw new ExtensionManifestError(`${where}.scope must be "read" or "operate"`);
  }
  return { method: method as ExtensionRouteMethod, path, scope: value.scope };
}

function parseBackend(value: unknown, source: string): ExtensionBackendManifest {
  if (!isRecord(value)) throw new ExtensionManifestError(`${source}: backend must be an object`);
  const command = value.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every(nonEmptyString)) {
    throw new ExtensionManifestError(`${source}: backend.command must be a non-empty string array`);
  }
  if (value.protocol !== EXTENSION_BACKEND_PROTOCOL) {
    throw new ExtensionManifestError(
      `${source}: backend.protocol must be ${EXTENSION_BACKEND_PROTOCOL}`,
    );
  }
  const cwd = value.cwd === undefined ? "." : value.cwd;
  if (!nonEmptyString(cwd)) throw new ExtensionManifestError(`${source}: backend.cwd is invalid`);
  if (value.dataDir !== undefined && !nonEmptyString(value.dataDir)) {
    throw new ExtensionManifestError(`${source}: backend.dataDir is invalid`);
  }
  if (
    value.watch !== undefined &&
    (!Array.isArray(value.watch) ||
      value.watch.length === 0 ||
      !value.watch.every(
        (pattern) =>
          nonEmptyString(pattern) &&
          !pattern.startsWith("/") &&
          !pattern.includes("\\") &&
          !pattern.includes(":") &&
          !pattern.startsWith("!") &&
          !pattern.split("/").includes(".."),
      ))
  ) {
    throw new ExtensionManifestError(
      source + ": backend.watch must be a non-empty array of relative globs or directories",
    );
  }
  const [first, ...rest] = command as string[];
  return {
    command: [first as string, ...rest],
    cwd,
    protocol: EXTENSION_BACKEND_PROTOCOL,
    ...(value.watch === undefined ? {} : { watch: value.watch as string[] }),
    ...(value.dataDir === undefined ? {} : { dataDir: value.dataDir as string }),
  };
}

export function parseExtensionManifest(
  value: unknown,
  source = EXTENSION_MANIFEST_FILE,
): ExtensionManifest {
  if (!isRecord(value)) throw new ExtensionManifestError(`${source}: manifest must be an object`);
  const id = value.id;
  if (typeof id !== "string" || !isValidExtensionId(id)) {
    throw new ExtensionManifestError(`${source}: id must match ${EXTENSION_ID.source}`);
  }
  if (value.sdk !== EXTENSION_SDK_VERSION) {
    throw new ExtensionManifestError(
      `${source}: extension "${id}" targets sdk ${String(value.sdk)}, host provides sdk ${EXTENSION_SDK_VERSION}`,
    );
  }
  if (value.web !== undefined && !nonEmptyString(value.web)) {
    throw new ExtensionManifestError(`${source}: web must be a relative module path`);
  }
  const routesValue = value.routes === undefined ? [] : value.routes;
  if (
    value.permissions !== undefined &&
    (!Array.isArray(value.permissions) ||
      value.permissions.some((permission) => permission !== "threads"))
  ) {
    throw new ExtensionManifestError(`${source}: permissions may contain only "threads"`);
  }
  if (!Array.isArray(routesValue))
    throw new ExtensionManifestError(`${source}: routes must be an array`);
  const routes = routesValue.map((route, index) => parseRoute(route, source, index));
  const backend = value.backend === undefined ? undefined : parseBackend(value.backend, source);
  if (routes.length > 0 && backend === undefined) {
    throw new ExtensionManifestError(`${source}: routes require a backend`);
  }
  return {
    id,
    sdk: EXTENSION_SDK_VERSION,
    routes,
    ...(value.permissions === undefined
      ? {}
      : { permissions: value.permissions.length === 0 ? [] : (["threads"] as const) }),
    ...(value.web === undefined ? {} : { web: value.web as string }),
    ...(backend === undefined ? {} : { backend }),
  };
}

/** Accepts `["../ext"]`, `{ "extensions": [...] }`, with string or `{ path, dataDir? }` entries. */
export function parseExtensionList(
  value: unknown,
  source = EXTENSION_LIST_FILE,
): ExtensionListEntry[] {
  const entries = Array.isArray(value) ? value : isRecord(value) ? value.extensions : undefined;
  if (!Array.isArray(entries)) {
    throw new ExtensionManifestError(`${source}: expected an array or { "extensions": [...] }`);
  }
  return entries.map((entry, index) => {
    if (nonEmptyString(entry)) return { path: entry };
    if (isRecord(entry) && nonEmptyString(entry.path)) {
      if (entry.dataDir !== undefined && !nonEmptyString(entry.dataDir)) {
        throw new ExtensionManifestError(`${source}: entry ${index} dataDir is invalid`);
      }
      return entry.dataDir === undefined
        ? { path: entry.path }
        : { path: entry.path, dataDir: entry.dataDir as string };
    }
    throw new ExtensionManifestError(`${source}: entry ${index} must be a path or { path }`);
  });
}

function pathMatches(pattern: string, path: string): boolean {
  const wanted = pattern.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  for (let index = 0; index < wanted.length; index++) {
    const segment = wanted[index];
    if (segment === "**") return true;
    const candidate = actual[index];
    if (candidate === undefined) return false;
    if (segment !== "*" && segment !== candidate) return false;
  }
  return wanted.length === actual.length;
}

/** First route whose method and path match. `path` is relative to `/ext/<id>` and excludes the query. */
export function matchExtensionRoute(
  routes: readonly ExtensionRoute[],
  method: string,
  path: string,
): ExtensionRoute | undefined {
  const upper = method.toUpperCase();
  return routes.find(
    (route) => (route.method === "*" || route.method === upper) && pathMatches(route.path, path),
  );
}
