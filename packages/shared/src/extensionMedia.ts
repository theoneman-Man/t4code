import { mediaMimeTypeFromExtension } from "./filePreview.ts";

export function extensionMediaThumbnailPath(path: string): string {
  const query = path.indexOf("?");
  const params = new URLSearchParams(query < 0 ? "" : path.slice(query + 1));
  params.set("w", "512");
  const thumbnail = (query < 0 ? path : path.slice(0, query)) + "?" + params.toString();
  return thumbnail.length <= 2048 ? thumbnail : path;
}

export function extensionMediaMimeType(path: string): string | undefined {
  const name = path.split("?", 1)[0]!;
  return mediaMimeTypeFromExtension(name.slice(name.lastIndexOf("."))) ?? undefined;
}
