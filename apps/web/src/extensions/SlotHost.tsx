import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AuthOrchestrationOperateScope, EnvironmentId } from "@t3tools/contracts";
import type { ExtContext } from "@t3tools/extension-sdk";
import type { ExtensionStatusResponse, ExtensionStatus } from "@t3tools/extension-sdk";
import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { RotateCwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { ExtensionRuntimeContext, extensionRootClass } from "./context";
import { cn } from "../lib/utils";
import { fetchEnvironmentPath, extensionPath } from "./http";
import type { ExtFetch } from "./events";
import type { RegisteredSlot } from "./registry";
import { refreshExtensionStatus, subscribeExtensionStatus, notifyBackendLifecycle } from "./status";
import { useEnvironmentScope } from "../state/session";

export function SlotHost({
  entry,
  context,
  active,
  fetch: suppliedFetch,
  status: suppliedStatus,
}: {
  entry: RegisteredSlot;
  context: ExtContext;
  active: boolean;
  fetch?: ExtFetch;
  status?: ExtensionStatus;
}) {
  const statusKey = `${context.environmentId}:${entry.extensionId}`;
  const canRestart = useEnvironmentScope(
    EnvironmentId.make(context.environmentId),
    AuthOrchestrationOperateScope,
  );
  const [restartError, setRestartError] = useState<string>();
  // eslint-disable-next-line t3code/no-manual-memo -- Extension hooks depend on stable fetch identity across host renders.
  const fetch = useCallback<ExtFetch>(
    async (path, init) => {
      const backendPath = extensionPath(entry.extensionId, path);
      const response = await (suppliedFetch
        ? suppliedFetch(path, init)
        : fetchEnvironmentPath(context.environmentId, backendPath, init));
      if (response.status === 503) refreshExtensionStatus(statusKey);
      return response;
    },
    [suppliedFetch, context.environmentId, entry.extensionId, statusKey],
  );
  // eslint-disable-next-line t3code/no-manual-memo -- The extension runtime context has an explicit identity contract.
  const runtime = useMemo(
    () => ({ extensionId: entry.extensionId, context, fetch }),
    [entry.extensionId, context, fetch],
  );
  const [result, setResult] = useState<{ key: string; status: ExtensionStatus } | null>(null);
  const [retry, setRetry] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string>();
  useEffect(
    () => subscribeExtensionStatus(statusKey, () => setRetry((value) => value + 1)),
    [statusKey],
  );
  useEffect(() => {
    if (suppliedStatus) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void fetchEnvironmentPath(context.environmentId, "/api/extensions", {
        signal: abort.signal,
        cache: retry === 0 ? "default" : "reload",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Extension status unavailable.");
          const body = (await response.json()) as ExtensionStatusResponse;
          const status = body.extensions.find((item) => item.id === entry.extensionId) ?? {
            id: entry.extensionId,
            backend: "failed" as const,
            message: "Extension is not installed in this environment.",
          };
          if (!abort.signal.aborted) {
            setResult({ key: statusKey, status });
            if (status.backend === "ready" || status.backend === "none") setLoadedKey(statusKey);
            if (status.lifecycle)
              notifyBackendLifecycle(statusKey, entry.extensionId, status.lifecycle);
          }
        })
        .catch(() => {
          if (!abort.signal.aborted)
            setResult({
              key: statusKey,
              status: {
                id: entry.extensionId,
                backend: "failed",
                message: "Could not read extension status.",
              },
            });
        })
        .finally(() => {
          if (!abort.signal.aborted) timer = setTimeout(refresh, 2_000);
        });
    };
    refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [context.environmentId, entry.extensionId, retry, suppliedStatus, statusKey]);
  const status = suppliedStatus ?? (result && result.key === statusKey ? result.status : null);
  const ready = status?.backend === "ready" || status?.backend === "none";
  const showView = ready || loadedKey === statusKey;
  const restart = async () => {
    setRestartError(undefined);
    try {
      const response = await fetchEnvironmentPath(
        context.environmentId,
        extensionPath(entry.extensionId, "/.t4/host/restart"),
        { method: "POST" },
      );
      if (!response.ok) throw new Error("Could not restart backend.");
      refreshExtensionStatus(statusKey);
    } catch {
      setRestartError("Could not restart backend.");
    }
  };
  const statusText = !ready
    ? `Backend ${status?.lifecycle?.state ?? status?.backend ?? "starting"}: ${status?.lifecycle?.lastError ?? status?.message ?? "Reconnecting..."}`
    : (status?.message ?? "Backend ready");
  const View = entry.slot.component;
  return (
    <div
      className={cn("relative flex min-h-0 flex-1 flex-col", extensionRootClass(entry.extensionId))}
      data-extension-id={entry.extensionId}
    >
      <ExtensionRuntimeContext value={runtime}>
        {status?.backend !== "none" && (
          // Sits in the title bar beside the window controls instead of taking a row.
          <div
            className={cn(
              "z-50 flex items-center [-webkit-app-region:no-drag]",
              entry.slot.kind === "workspace"
                ? "fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)]"
                : "absolute top-1 right-1",
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="relative"
                    disabled={!canRestart}
                    aria-label={`Restart backend. ${statusText}`}
                    onClick={() => {
                      void restart();
                    }}
                  >
                    <RotateCwIcon />
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-1 right-1 size-1.5 rounded-full",
                        restartError || status?.backend === "failed"
                          ? "bg-destructive"
                          : ready
                            ? "bg-emerald-500"
                            : "bg-amber-500",
                      )}
                    />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">
                <span role="status">{statusText}</span>
                {restartError && <span role="alert"> {restartError}</span>}
                {canRestart && (
                  <span className="block text-muted-foreground">Click to restart</span>
                )}
              </TooltipPopup>
            </Tooltip>
          </div>
        )}
        <RenderErrorBoundary
          resetKeys={[entry.key, context.environmentId]}
          fallback={
            <p role="alert" className="p-4 text-sm text-muted-foreground">
              This extension view could not be displayed.
            </p>
          }
        >
          {showView ? (
            <Suspense
              fallback={
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  Loading extension...
                </p>
              }
            >
              <View context={context} active={active} />
            </Suspense>
          ) : (
            <div
              role="status"
              className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground"
            >
              <p>
                Extension {status?.backend ?? "starting"}
                {status?.message ? `: ${status.message}` : "."}
              </p>
              <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
                Refresh status
              </Button>
            </div>
          )}
        </RenderErrorBoundary>
      </ExtensionRuntimeContext>
    </div>
  );
}
