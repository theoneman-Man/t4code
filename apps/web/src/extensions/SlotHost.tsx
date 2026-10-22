import { Suspense, useEffect, useState } from "react";
import type { ExtContext } from "@t3tools/extension-sdk";
import type { ExtensionStatusResponse, ExtensionStatus } from "@t3tools/extension-sdk";
import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { Button } from "../components/ui/button";
import { ExtensionRuntimeContext, extensionRootClass } from "./context";
import { cn } from "../lib/utils";
import { fetchEnvironmentPath, extensionPath } from "./http";
import type { ExtFetch } from "./events";
import type { RegisteredSlot } from "./registry";
import { refreshExtensionStatus, subscribeExtensionStatus } from "./status";

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
  const fetch: ExtFetch = async (path, init) => {
    const response = await (suppliedFetch
      ? suppliedFetch(path, init)
      : fetchEnvironmentPath(context.environmentId, extensionPath(entry.extensionId, path), init));
    if (response.status === 503) refreshExtensionStatus(statusKey);
    return response;
  };
  const [result, setResult] = useState<{ environmentId: string; status: ExtensionStatus } | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  useEffect(
    () => subscribeExtensionStatus(statusKey, () => setRetry((value) => value + 1)),
    [statusKey],
  );
  useEffect(() => {
    if (suppliedStatus) return;
    const abort = new AbortController();
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
        if (!abort.signal.aborted) setResult({ environmentId: context.environmentId, status });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setResult({
            environmentId: context.environmentId,
            status: {
              id: entry.extensionId,
              backend: "failed",
              message: "Could not read extension status.",
            },
          });
      });
    return () => abort.abort();
  }, [context.environmentId, entry.extensionId, retry, suppliedStatus]);
  const status =
    suppliedStatus ??
    (result && result.environmentId === context.environmentId ? result.status : null);
  const ready = status?.backend === "ready" || status?.backend === "none";
  const View = entry.slot.component;
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", extensionRootClass(entry.extensionId))}
      data-extension-id={entry.extensionId}
    >
      <ExtensionRuntimeContext value={{ extensionId: entry.extensionId, context, fetch }}>
        <RenderErrorBoundary
          resetKeys={[entry.key, context.environmentId]}
          fallback={
            <p role="alert" className="p-4 text-sm text-muted-foreground">
              This extension view could not be displayed.
            </p>
          }
        >
          {ready ? (
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
