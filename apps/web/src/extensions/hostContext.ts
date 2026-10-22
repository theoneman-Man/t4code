import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useThreadShell } from "../state/entities";
import { useOptionalSettingsScope } from "../components/settings/SettingsScopeContext";
import type { ExtContext } from "@t3tools/extension-sdk";

export function useHostExtContext(): ExtContext | null {
  const ref = useThreadRouteRef();
  const thread = useThreadShell(ref);
  const primaryId = usePrimaryEnvironmentId();
  const settings = useOptionalSettingsScope();
  const environmentId = settings?.environment?.environmentId ?? ref?.environmentId ?? primaryId;
  if (!environmentId) return null;
  return {
    environmentId,
    ...(ref ? { threadId: ref.threadId } : {}),
    ...(thread ? { projectId: thread.projectId } : {}),
  };
}
