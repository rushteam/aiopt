import { describe, expect, it } from 'vitest';
import { requestAnthropicToOpenai } from '../translate/anthropicToOpenai';
import { requestOpenaiToAnthropic } from '../translate/openaiToAnthropic';
import { requestResponsesToOpenai } from '../translate/responsesOpenai';
import { requestResponsesToAnthropic } from '../translate/responsesAnthropic';
import { requestAnthropicToGemini, requestOpenaiToGemini } from '../translate/gemini';
import { MAX_IMAGE_BASE64, urlToAnthropicImage } from '../translate/images';
import type { AnthropicRequest, OpenAiRequest, ResponsesRequest } from '../translate/types';

const PNG = 'iVBORw0KGgo=';
const DATA_URL = `data:image/png;base64,${PNG}`;
const b64Block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };

describe('image gate', () => {
  it('accepts base64 data URLs and https URLs', () => {
    expect(urlToAnthropicImage(DATA_URL)).toEqual(b64Block);
    expect(urlToAnthropicImage('https://x.test/a.png').source).toEqual({ type: 'url', url: 'https://x.test/a.png' });
  });

  it('refuses http, file, odd media types, bad base64 and oversized data', () => {
    for (const url of [
      'http://x.test/a.png',
      'file:///etc/passwd',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png,raw',
      'data:image/png;base64,***',
      `data:image/png;base64,${'A'.repeat(MAX_IMAGE_BASE64 + 4)}`,
    ]) {
      expect(() => urlToAnthropicImage(url), url.slice(0, 30)).toThrow(/UNSUPPORTED_CAPABILITY/);
    }
  });
});

describe('Anthropic → OpenAI Chat images', () => {
  it('maps a user image to an image_url part, keeping order', () => {
    const req: AnthropicRequest = {
      max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, b64Block] }],
    };
    const out = requestAnthropicToOpenai(req, 'gpt');
    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: DATA_URL } },
        ],
      },
    ]);
  });

  it('carries a tool_result screenshot into the following user message', () => {
    const req: AnthropicRequest = {
      max_tokens: 10,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }, b64Block] }],
        },
      ],
    };
    const out = requestAnthropicToOpenai(req, 'gpt');
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ok' });
    expect(out.messages[2]).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: DATA_URL } }] });
  });

  it('refuses an image on an assistant turn', () => {
    const req: AnthropicRequest = { max_tokens: 10, messages: [{ role: 'assistant', content: [b64Block] }] };
    expect(() => requestAnthropicToOpenai(req, 'gpt')).toThrow(/UNSUPPORTED_CAPABILITY/);
  });
});

describe('OpenAI Chat → Anthropic images', () => {
  it('maps image_url parts (data and https) to image blocks', () => {
    const req: OpenAiRequest = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'compare' },
            { type: 'image_url', image_url: { url: DATA_URL } },
            { type: 'image_url', image_url: { url: 'https://x.test/b.jpg' } },
          ],
        },
      ],
    };
    const out = requestOpenaiToAnthropic(req, 'claude');
    expect(out.messages[0]!.content).toEqual([
      { type: 'text', text: 'compare' },
      b64Block,
      { type: 'image', source: { type: 'url', url: 'https://x.test/b.jpg' } },
    ]);
  });

  it('keeps text-only part arrays as a string (no silent drop any more)', () => {
    const req: OpenAiRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    expect(requestOpenaiToAnthropic(req, 'claude').messages[0]!.content).toBe('hi');
  });
});

describe('Responses images', () => {
  const req: ResponsesRequest = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: DATA_URL },
        ],
      },
    ],
  };

  it('lowers input_image to a Chat image_url part', () => {
    expect(requestResponsesToOpenai(req, 'm').messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: DATA_URL } },
      ],
    });
  });

  it('lowers input_image to an Anthropic image block', () => {
    expect(requestResponsesToAnthropic(req, 'm').messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'look' }, b64Block],
    });
  });

  it('refuses a file_id image', () => {
    const bad: ResponsesRequest = {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }],
    };
    expect(() => requestResponsesToOpenai(bad, 'm')).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(() => requestResponsesToAnthropic(bad, 'm')).toThrow(/UNSUPPORTED_CAPABILITY/);
  });
});

describe('Gemini images', () => {
  it('maps inline images to inlineData on both inbound dialects', () => {
    const a = requestAnthropicToGemini({ max_tokens: 10, messages: [{ role: 'user', content: [b64Block] }] });
    expect(a.contents[0]!.parts).toEqual([{ inlineData: { mimeType: 'image/png', data: PNG } }]);
    const o = requestOpenaiToGemini({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'x' },
            { type: 'image_url', image_url: { url: DATA_URL } },
          ],
        },
      ],
    });
    expect(o.contents[0]!.parts).toEqual([{ text: 'x' }, { inlineData: { mimeType: 'image/png', data: PNG } }]);
  });

  it('refuses a remote image (Gemini cannot fetch it)', () => {
    expect(() =>
      requestOpenaiToGemini({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] }],
      }),
    ).toThrow(/UNSUPPORTED_CAPABILITY/);
  });
});
