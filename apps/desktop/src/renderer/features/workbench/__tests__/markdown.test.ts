import { describe, expect, it } from 'vitest';
import { isExternalHref, isMarkdownPath, parseInline, parseMarkdown, plainText } from '../markdown';

describe('markdown', () => {
  it('recognises Markdown file names', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/a.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('a.mdx')).toBe(true);
    expect(isMarkdownPath('a.txt')).toBe(false);
    expect(isMarkdownPath('md')).toBe(false);
  });

  it('only treats absolute http(s) targets as external links', () => {
    expect(isExternalHref('https://example.com/a')).toBe(true);
    expect(isExternalHref('http://x')).toBe(true);
    expect(isExternalHref('javascript:alert(1)')).toBe(false);
    expect(isExternalHref('file:///etc/passwd')).toBe(false);
    expect(isExternalHref('./docs/a.md')).toBe(false);
    expect(isExternalHref('https://a b')).toBe(false);
  });

  it('parses headings, paragraphs, rules and setext headings', () => {
    const blocks = parseMarkdown('# Title #\n\nSome *text*\nmore\n\n---\n\nSub\n===\n');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'hr', 'heading']);
    expect(blocks[0]).toEqual({ type: 'heading', level: 1, children: [{ type: 'text', text: 'Title' }] });
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'Some ' },
        { type: 'em', children: [{ type: 'text', text: 'text' }] },
        { type: 'text', text: '\nmore' },
      ],
    });
    expect(blocks[3]).toMatchObject({ type: 'heading', level: 1 });
  });

  it('keeps fenced and indented code verbatim, including HTML', () => {
    const blocks = parseMarkdown(
      '```ts\nconst a = "<script>";\n\n# not a heading\n```\n\n    indented\n    <b>x</b>\n',
    );
    expect(blocks).toEqual([
      { type: 'code', lang: 'ts', text: 'const a = "<script>";\n\n# not a heading' },
      { type: 'code', lang: '', text: 'indented\n<b>x</b>' },
    ]);
    // An unclosed fence runs to the end.
    expect(parseMarkdown('~~~\na')).toEqual([{ type: 'code', lang: '', text: 'a' }]);
  });

  it('leaves raw HTML as text', () => {
    expect(parseMarkdown('<img src=x onerror=alert(1)>')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
    ]);
  });

  it('parses lists, nested lists and task items', () => {
    const [list] = parseMarkdown('- a\n- [x] done\n  - nested\n- [ ] todo\n\n3. three\n4. four\n');
    expect(list).toMatchObject({ type: 'list', ordered: false });
    if (list?.type !== 'list') throw new Error('not a list');
    expect(list.items.map((i) => i.checked)).toEqual([null, true, false]);
    expect(list.items[1]!.children.map((b) => b.type)).toEqual(['paragraph', 'list']);
    const ordered = parseMarkdown('3. three\n4. four\n')[0];
    expect(ordered).toMatchObject({ type: 'list', ordered: true, start: 3 });
    // A loose list (blank lines between items) is still one list.
    const loose = parseMarkdown('- a\n\n- b\n');
    expect(loose).toHaveLength(1);
  });

  it('parses quotes with lazy continuation', () => {
    const [quote] = parseMarkdown('> a\nb\n> # h\n');
    expect(quote?.type).toBe('quote');
    if (quote?.type !== 'quote') throw new Error('not a quote');
    expect(quote.children.map((b) => b.type)).toEqual(['paragraph', 'heading']);
  });

  it('parses GFM tables with alignment and escaped pipes', () => {
    const [table] = parseMarkdown('| a | b | c |\n|:--|:-:|--:|\n| 1 | `x|y` | a\\|b |\n| 2 |\n');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') throw new Error('not a table');
    expect(table.align).toEqual(['left', 'center', 'right']);
    expect(table.rows).toHaveLength(2);
    expect(plainText(table.rows[0]![1]!)).toBe('x|y');
    expect(plainText(table.rows[0]![2]!)).toBe('a|b');
    expect(table.rows[1]![2]).toEqual([]);
  });

  it('parses inline code, emphasis, strikethrough and escapes', () => {
    expect(parseInline('`a*b*` **bold** ~~gone~~ \\*lit\\* snake_case_name')).toEqual([
      { type: 'code', text: 'a*b*' },
      { type: 'text', text: ' ' },
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' ' },
      { type: 'del', children: [{ type: 'text', text: 'gone' }] },
      { type: 'text', text: ' *lit* snake_case_name' },
    ]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
  });

  it('parses links, autolinks, bare URLs and images', () => {
    expect(parseInline('[docs](https://a.dev/x "t") <https://b.dev> see https://c.dev/p. ![logo](img.png)')).toEqual([
      { type: 'link', href: 'https://a.dev/x', children: [{ type: 'text', text: 'docs' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://b.dev', children: [{ type: 'text', text: 'https://b.dev' }] },
      { type: 'text', text: ' see ' },
      { type: 'link', href: 'https://c.dev/p', children: [{ type: 'text', text: 'https://c.dev/p' }] },
      { type: 'text', text: '. ' },
      { type: 'image', alt: 'logo', src: 'img.png' },
    ]);
    expect(parseInline('[not a link] (x)')).toEqual([{ type: 'text', text: '[not a link] (x)' }]);
  });

  it('turns trailing double spaces and backslashes into line breaks', () => {
    expect(parseInline('a  \nb\\\nc')).toEqual([
      { type: 'text', text: 'a' },
      { type: 'br' },
      { type: 'text', text: 'b' },
      { type: 'br' },
      { type: 'text', text: 'c' },
    ]);
  });

  it('bounds nesting depth', () => {
    expect(() => parseMarkdown('>'.repeat(5000) + ' x')).not.toThrow();
    expect(() => parseInline('*'.repeat(5000) + 'x' + '*'.repeat(5000))).not.toThrow();
    expect(() => parseInline('['.repeat(5000) + 'x')).not.toThrow();
  });

  it('stays fast on a preview-sized file full of unmatched markers', () => {
    const noisy = '*a [b `c _d ~~e '.repeat(16 * 1024); // ~256 KB, one paragraph
    const started = performance.now();
    parseMarkdown(noisy);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
