import { useEffect } from "react";
import type { ExtensionStatusResponse } from "@t3tools/extension-sdk/protocol";
import { usePrimaryEnvironment } from "../state/environments";
import { fetchEnvironmentPath } from "./http";
import { notifyBackendLifecycle } from "./status";

export function ExtensionBackendNotifications() {
  const environmentId = usePrimaryEnvironment()?.environmentId;
  useEffect(() => {
    if (!environmentId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const response = await fetchEnvironmentPath(environmentId, "/api/extensions", {
          signal: abort.signal,
          cache: "no-store",
        });
        if (response.ok) {
          const body = (await response.json()) as ExtensionStatusResponse;
          if (!abort.signal.aborted)
            for (const status of body.extensions) {
              if (status.lifecycle)
                notifyBackendLifecycle(
                  `${environmentId}:${status.id}`,
                  status.id,
                  status.lifecycle,
                );
            }
        }
      } catch {
        /* Connection status already reports environment transport failures. */
      } finally {
        if (!abort.signal.aborted)
          timer = setTimeout(() => {
            void refresh();
          }, 5_000);
      }
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [environmentId]);
  return null;
}
