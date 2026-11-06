import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useComposerDraftStore } from "../composerDraftStore";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useThreadShell } from "../state/entities";
import { useOptionalSettingsScope } from "../components/settings/SettingsScopeContext";
import type { ExtContext } from "@t3tools/extension-sdk";

export function useHostExtContext(): ExtContext | null {
  const target = useThreadRouteTarget();
  const ref = target?.kind === "server" ? target.threadRef : null;
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  const thread = useThreadShell(ref);
  const primaryId = usePrimaryEnvironmentId();
  const settings = useOptionalSettingsScope();
  const environmentId =
    settings?.environment?.environmentId ?? ref?.environmentId ?? draft?.environmentId ?? primaryId;
  if (!environmentId) return null;
  return {
    environmentId,
    ...(ref ? { threadId: ref.threadId } : {}),
    ...(thread ? { projectId: thread.projectId } : draft ? { projectId: draft.projectId } : {}),
  };
}
