// Image content across dialects (pure).
//
//   Anthropic   { type: 'image', source: { type: 'base64', media_type, data } | { type: 'url', url } }
//   OpenAI Chat { type: 'image_url', image_url: { url: 'data:<mt>;base64,…' | 'https://…', detail? } }
//   Responses   { type: 'input_image', image_url: '…', detail? }  (a `file_id` image is refused)
//
// Every image passes one gate: an inline image must be one of the media types every vendor
// accepts and be well-formed base64 under a size cap; a remote image must be an https URL
// (the UPSTREAM fetches it — we never do). Anything else is refused with the same coded error
// the translators use, never dropped silently. Image data is never logged.

import { rejectUnsupported } from './types';

/** The media types Anthropic, OpenAI and the OpenAI-compatible vendors all accept. */
const MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Per-image cap on inline base64 (≈ 15 MB decoded) — above every vendor's own limit. */
export const MAX_IMAGE_BASE64 = 20 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}

export interface OpenAiImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}

function checkInline(mediaType: string, data: string): void {
  const mt = mediaType.toLowerCase();
  if (!MEDIA_TYPES.has(mt)) rejectUnsupported(`image type "${mt.slice(0, 40)}" is not supported by the translation proxy`);
  if (data.length === 0 || data.length > MAX_IMAGE_BASE64) {
    rejectUnsupported('image data is empty or too large for the translation proxy');
  }
  if (!BASE64.test(data)) rejectUnsupported('image data is not valid base64');
}

function checkRemote(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return rejectUnsupported('image URL is not valid');
  }
  if (u.protocol !== 'https:') rejectUnsupported('only https image URLs are supported by the translation proxy');
}

/** An image URL (data: or https:) → the Anthropic image block. */
export function urlToAnthropicImage(url: unknown): AnthropicImageBlock {
  if (typeof url !== 'string' || url === '') return rejectUnsupported('image URL is missing');
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) {
    const mediaType = m[1]!.toLowerCase();
    const data = m[2]!;
    checkInline(mediaType, data);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  if (url.startsWith('data:')) rejectUnsupported('only base64 data URLs are supported for images');
  checkRemote(url);
  return { type: 'image', source: { type: 'url', url } };
}

/** An Anthropic image block → the image URL (data: or https:) OpenAI-style dialects take. */
export function anthropicImageToUrl(block: unknown): string {
  const source = (block as { source?: Record<string, unknown> } | null)?.source;
  if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
    checkInline(source.media_type, source.data);
    return `data:${source.media_type.toLowerCase()};base64,${source.data}`;
  }
  if (source?.type === 'url' && typeof source.url === 'string') {
    checkRemote(source.url);
    return source.url;
  }
  return rejectUnsupported('Anthropic image source is not supported by the translation proxy');
}

/** An Anthropic image block → an OpenAI Chat image part. */
export function anthropicImageToOpenai(block: unknown): OpenAiImagePart {
  return { type: 'image_url', image_url: { url: anthropicImageToUrl(block) } };
}

/** The URL of an OpenAI Chat `image_url` part (string or `{ url }` form). */
export function openaiImageUrl(part: unknown): string {
  const iu = (part as { image_url?: unknown } | null)?.image_url;
  const url = typeof iu === 'string' ? iu : (iu as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || url === '') return rejectUnsupported('image URL is missing');
  if (!url.startsWith('data:')) checkRemote(url);
  else urlToAnthropicImage(url); // validates the inline form
  return url;
}

/** An image URL → Gemini `inlineData`. Gemini cannot fetch an arbitrary https URL. */
export function urlToGeminiInline(url: string): { inlineData: { mimeType: string; data: string } } {
  const img = urlToAnthropicImage(url);
  if (img.source.type !== 'base64') {
    return rejectUnsupported('only inline (base64) images are supported for Gemini by the translation proxy');
  }
  return { inlineData: { mimeType: img.source.media_type, data: img.source.data } };
}

/** The URL of a Responses `input_image` part (a `file_id` image cannot be resolved here). */
export function responsesImageUrl(part: unknown): string {
  const p = part as { image_url?: unknown; file_id?: unknown } | null;
  if (typeof p?.image_url !== 'string' || p.image_url === '') {
    return rejectUnsupported('Responses `input_image` needs an image_url (file_id images are not supported)');
  }
  return openaiImageUrl({ image_url: p.image_url });
}
