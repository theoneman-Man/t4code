// Wire contract between the host, extension backends and the extension web runtime.
// Pure: safe to import from the browser, the server and the desktop app.

/** Environment variables the host sets when it launches an extension backend (protocol 1). */
export const EXTENSION_BACKEND_ENV = {
  id: "T4_EXT_ID",
  port: "T4_EXT_PORT",
  token: "T4_EXT_TOKEN",
  dataDir: "T4_EXT_DATA_DIR",
  instance: "T4_EXT_INSTANCE",
} as const;

/** Backend readiness probe; answered with `ExtensionBackendReady` (bearer required). */
export const EXTENSION_READY_PATH = "/.t4/ready";
export const EXTENSION_READY_TIMEOUT_MS = 60_000;
export const EXTENSION_MAX_RESTARTS = 5;

export interface ExtensionBackendReady {
  readonly protocol: 1;
  readonly extensionId: string;
  readonly instanceId: string;
  readonly dataDir: string;
}

export type ExtensionBackendState = "starting" | "ready" | "restarting" | "failed" | "stopped";

/** Browser-facing proxy prefix: `/ext/<id>/<backend path>`. */
export const EXTENSION_PROXY_PREFIX = "/ext";

/** Host status endpoint (orchestration:read): `{ extensions: ExtensionStatus[] }`. */
export const EXTENSION_STATUS_PATH = "/api/extensions";

export interface ExtensionStatus {
  readonly id: string;
  /** `none` when the extension declares no backend. */
  readonly backend: ExtensionBackendState | "none";
  /** Human-readable reason for `failed`/`restarting`; never contains secrets. */
  readonly message?: string;
}

export interface ExtensionStatusResponse {
  readonly extensions: readonly ExtensionStatus[];
}

/**
 * Backend event stream, reached through the proxy as `GET /ext/<id>/events?cursor=<last id>`.
 * Server-sent events: `id:` is an opaque cursor, `event:` the topic, `data:` one JSON value.
 * Comment lines (`: heartbeat`) keep the connection alive. A `reset` event means events were
 * lost (retention gap or backend restart): clients must reload their state for every topic.
 */
export const EXTENSION_EVENTS_PATH = "/events";
export const EXTENSION_EVENTS_RESET_TOPIC = "reset";

export interface ExtensionEvent {
  readonly topic: string;
  readonly cursor: string;
  readonly data: unknown;
}
