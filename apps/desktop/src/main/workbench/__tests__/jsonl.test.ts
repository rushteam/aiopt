import { describe, expect, it, vi } from 'vitest';
import { createJsonlDecoder, encodeJsonl, MAX_JSONL_LINE } from '../jsonl';

function collect() {
  const records: Record<string, unknown>[] = [];
  const invalid = vi.fn();
  const decoder = createJsonlDecoder((r) => records.push(r), invalid);
  return { records, invalid, decoder };
}

describe('jsonl decoder', () => {
  it('splits records across arbitrary chunk boundaries', () => {
    const { records, decoder } = collect();
    decoder.push('{"a":1}\n{"b"');
    decoder.push(':2}\n{"c":3');
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
    decoder.push('}\n');
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('strips a trailing CR and skips blank lines', () => {
    const { records, decoder } = collect();
    decoder.push('{"a":1}\r\n\n  \n{"b":2}\n');
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('keeps U+2028 / U+2029 inside a record (readline would split there)', () => {
    const { records, decoder } = collect();
    decoder.push(`{"text":"one two three"}\n`);
    expect(records).toEqual([{ text: 'one two three' }]);
  });

  it('reports and skips invalid lines without stopping the stream', () => {
    const { records, invalid, decoder } = collect();
    decoder.push('not json\n[1,2]\n"str"\n{"ok":true}\n');
    expect(records).toEqual([{ ok: true }]);
    expect(invalid.mock.calls.map((c) => c[0])).toEqual(['parse', 'not_object', 'not_object']);
  });

  it('flushes an unterminated final line on end()', () => {
    const { records, decoder } = collect();
    decoder.push('{"last":1}');
    expect(records).toEqual([]);
    decoder.end();
    expect(records).toEqual([{ last: 1 }]);
  });

  it('drops a runaway line and resumes at the next newline', () => {
    const { records, invalid, decoder } = collect();
    decoder.push('x'.repeat(MAX_JSONL_LINE + 1));
    decoder.push('still the same line');
    decoder.push('\n{"after":1}\n');
    expect(invalid).toHaveBeenCalledWith('too_long');
    expect(records).toEqual([{ after: 1 }]);
  });

  it('encodes one record per line, escaping embedded newlines', () => {
    const line = encodeJsonl({ message: 'a\nb' });
    expect(line).toBe('{"message":"a\\nb"}\n');
    const { records, decoder } = collect();
    decoder.push(line);
    expect(records).toEqual([{ message: 'a\nb' }]);
  });
});
