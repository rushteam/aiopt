// Images the user pastes or drops into the coordinator composer (pure).
//
// The renderer is untrusted: it hands main a list of `{ mimeType, data }` and main re-checks
// every one before it reaches pi — the count, the declared type (only the four every vendor
// accepts), strict base64 under a size cap, and that the decoded bytes really start with that
// type's file signature. Anything off is refused with INVALID_PARAMS, never dropped silently.
// Image data is never logged and never written by AiOpt (pi keeps it in the conversation file).

import { throwIpcError } from '../ipc/validate';
import { WORKBENCH_LIMITS, isChatImageType, type ChatImage, type ChatImageType } from '../../shared/workbench';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Each type's leading bytes (magic number). */
function hasSignature(type: ChatImageType, head: Buffer): boolean {
  switch (type) {
    case 'image/png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/gif':
      return head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a';
    case 'image/webp':
      return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  }
}

/** The validated image list of a chat-send payload (`undefined` → none). */
export function requireChatImages(raw: unknown): ChatImage[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'images must be an array');
  if (raw.length > WORKBENCH_LIMITS.chatImages) throwIpcError('INVALID_PARAMS', 'too many images');
  return raw.map((item: unknown) => {
    const record = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (!record) throwIpcError('INVALID_PARAMS', 'image must be an object');
    const { mimeType, data } = record;
    if (!isChatImageType(mimeType)) throwIpcError('INVALID_PARAMS', 'unsupported image type');
    if (typeof data !== 'string' || data.length === 0 || data.length > WORKBENCH_LIMITS.chatImageBase64) {
      throwIpcError('INVALID_PARAMS', 'image is empty or too large');
    }
    if (data.length % 4 !== 0 || !BASE64.test(data)) throwIpcError('INVALID_PARAMS', 'image is not valid base64');
    // 16 base64 characters decode to the 12 bytes the longest signature needs.
    if (!hasSignature(mimeType, Buffer.from(data.slice(0, 16), 'base64'))) {
      throwIpcError('INVALID_PARAMS', 'image content does not match its type');
    }
    return { mimeType, data };
  });
}
