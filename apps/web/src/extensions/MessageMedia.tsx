import { extensionMediaThumbnailPath } from "@t3tools/shared/extensionMedia";
import type { EnvironmentId, OrchestrationMessageContext } from "@t3tools/contracts";
import { useAssetUrlRefresh, useAssetUrlState } from "../assets/assetUrls";
import type { ExpandedImagePreview } from "../components/chat/ExpandedImagePreview";

type Media = NonNullable<OrchestrationMessageContext["extensionMedia"]>;

function MediaImage({
  environmentId,
  extensionId,
  item,
  onExpand,
}: {
  environmentId: EnvironmentId;
  extensionId: string;
  item: Media["items"][number];
  onExpand: (preview: ExpandedImagePreview) => void;
}) {
  const resource = { _tag: "extension-media" as const, extensionId, path: item.path };
  const thumbnail = useAssetUrlState(environmentId, {
    ...resource,
    path: extensionMediaThumbnailPath(item.path),
  });
  const full = useAssetUrlRefresh(environmentId, resource);
  const name = item.name ?? "Extension image";
  return (
    <button
      type="button"
      className="aspect-[4/3] overflow-hidden rounded-lg border border-border/80 cursor-zoom-in"
      aria-label={"Preview " + name}
      onClick={() =>
        void full()
          .then((src) => {
            if (src)
              onExpand({
                index: 0,
                images: [
                  {
                    src,
                    name,
                    ...(item.mimeType ? { mimeType: item.mimeType } : {}),
                    actionsSource: { kind: "image", name, src, asset: { environmentId, resource } },
                  },
                ],
              });
          })
          .catch(() => {})
      }
    >
      {thumbnail._tag === "Success" ? (
        <img
          src={thumbnail.url}
          alt={name}
          loading="lazy"
          decoding="async"
          width={256}
          height={192}
          className="size-full object-cover"
        />
      ) : (
        <span>{name}</span>
      )}
    </button>
  );
}

export function ExtensionMessageMedia({
  environmentId,
  media,
  onExpand,
}: {
  environmentId: EnvironmentId;
  media: Media | undefined;
  onExpand: (preview: ExpandedImagePreview) => void;
}) {
  if (!media?.items.length) return null;
  return (
    <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
      {media.items.map((item, index) => (
        <MediaImage
          key={`${index}:${item.path}`}
          environmentId={environmentId}
          extensionId={media.extensionId}
          item={item}
          onExpand={onExpand}
        />
      ))}
    </div>
  );
}
