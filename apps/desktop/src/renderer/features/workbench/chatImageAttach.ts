// Images the user pastes, drops or picks for a coordinator message. Read in the renderer (no
// privileged API: the file object the browser handed over), scaled so its long side is at most
// MAX_SIDE and re-encoded when its type is not one every model vendor accepts. Main re-checks
// whatever this sends (main/workbench/chatImages.ts).

import { WORKBENCH_LIMITS, isChatImageType, type ChatImage } from '../../../shared/workbench';

/** Long side, in pixels, an attached image is scaled down to (pi's own default limit). */
const MAX_SIDE = 2000;

export interface DraftImage extends ChatImage {
  id: string;
}

export type ImageAttachError = 'tooMany' | 'unreadable' | 'tooLarge';

let nextId = 0;

/** The image files among a paste / drop / pick. */
export function imageFiles(list: FileList | readonly File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** One file as an attachable image, or the reason it cannot be one. */
export async function readImageFile(file: File): Promise<DraftImage | ImageAttachError> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return 'unreadable';
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && isChatImageType(file.type)) {
      const data = base64Of(new Uint8Array(await file.arrayBuffer()));
      if (data.length <= WORKBENCH_LIMITS.chatImageBase64) {
        nextId += 1;
        return { id: `img${nextId}`, mimeType: file.type, data };
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'unreadable';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // PNG keeps screenshots crisp; a photo-sized PNG falls back to JPEG.
    for (const [type, quality] of [
      ['image/png', undefined],
      ['image/jpeg', 0.85],
    ] as const) {
      const url = canvas.toDataURL(type, quality);
      const data = url.slice(url.indexOf(',') + 1);
      if (url.startsWith(`data:${type};base64,`) && data.length <= WORKBENCH_LIMITS.chatImageBase64) {
        nextId += 1;
        return { id: `img${nextId}`, mimeType: type, data };
      }
    }
    return 'tooLarge';
  } finally {
    bitmap.close();
  }
}

/** A thumbnail URL for an attached image (data: URLs are allowed by the CSP's img-src). */
export function imagePreviewUrl(image: ChatImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
