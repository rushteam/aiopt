// Rendered Markdown: a file in the preview, or a coordinator reply in chat. It maps
// `parseMarkdown`'s data tree to React elements, so the text only ever lands in text nodes.
// Nothing from it is inserted as HTML, and it carries no styles or scripts.
//
// - Links: only absolute http(s) targets become anchors. They open in the system browser
//   through main's window-open handler, the same way the About link does. Any other target
//   (relative, file:, javascript:, …) is plain text, unless the host's `localLink` resolves it
//   to a file in an added folder (opened in the preview, never navigated to).
// - Images are never loaded. A remote image would be a tracking request, and a relative one
//   cannot resolve here. Each image shows as its alt text with an image marker.

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { isExternalHref, outlineOf, parseMarkdown, type Block, type Inline } from './markdown';
import { ImageIcon } from './workbenchIcons';
import { hoverBackground } from '../../lib/hover';
import { segmentButtonChrome, segmentedRootStyle } from '../../components/ui/controlStyles';
import type { TranslateFn } from '../../i18n';

/** How a host fills in the parts that depend on where the Markdown is shown. */
export interface MarkdownRenderers {
  /** A run of plain text (and the text of inline code), e.g. to link file paths in it. */
  text?: (text: string) => ReactNode;
  /** A link whose target is not http(s); absent, it shows as plain text. */
  localLink?: (href: string, children: ReactNode) => ReactNode;
  /** A fenced code block; absent, a plain `<pre>`. */
  codeBlock?: (block: { lang: string; text: string }) => ReactNode;
}

interface Ctx extends MarkdownRenderers {
  imageLabel: string;
  heading: Record<1 | 2 | 3 | 4 | 5 | 6, CSSProperties>;
}

/** Past this width the document shows its table of contents beside the text. */
const OUTLINE_MIN_WIDTH = 900;
/** A table of contents only helps once a document has this many headings. */
const OUTLINE_MIN_HEADINGS = 3;

export function MarkdownView({
  text,
  imageLabel,
  variant = 'document',
  renderers,
  outlineLabel,
}: {
  text: string;
  imageLabel: string;
  /** `document`: a padded reading column (preview); `chat`: fits inside a message. */
  variant?: 'document' | 'chat';
  renderers?: MarkdownRenderers;
  /** Set to show a table of contents (document variant, wide enough, enough headings). */
  outlineLabel?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const chat = variant === 'chat';
  const ctx: Ctx = { ...renderers, imageLabel, heading: chat ? chatHeadingStyle : headingStyle };
  const body = (
    <div className="aiopt-md" style={chat ? chatRootStyle : rootStyle}>
      {renderBlocks(blocks, ctx, true)}
    </div>
  );
  if (chat || !outlineLabel) return body;
  return <WithOutline blocks={blocks} label={outlineLabel} body={body} />;
}

/** The rendered / source switch in a Markdown view's header. */
export function MarkdownModeToggle({
  mode,
  onChange,
  t,
}: {
  mode: 'rendered' | 'source';
  onChange: (mode: 'rendered' | 'source') => void;
  t: TranslateFn;
}) {
  return (
    <div role="group" aria-label={t('workbench.explorer.viewMode')} style={{ ...segmentedRootStyle, flexShrink: 0 }}>
      {(['rendered', 'source'] as const).map((m, index) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(m)}
            style={{
              ...segmentButtonChrome('sm'),
              fontSize: fontSize.xs,
              borderLeft: index === 0 ? 'none' : `1px solid ${token('border')}`,
              background: active ? token('accent') : 'transparent',
              color: active ? token('accentText') : token('text'),
              cursor: active ? 'default' : 'pointer',
            }}
          >
            {t(m === 'rendered' ? 'workbench.explorer.rendered' : 'workbench.explorer.source')}
          </button>
        );
      })}
    </div>
  );
}

function WithOutline({ blocks, label, body }: { blocks: Block[]; label: string; body: ReactNode }) {
  const outline = useMemo(() => outlineOf(blocks), [blocks]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWide(el.clientWidth >= OUTLINE_MIN_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const show = wide && outline.length >= OUTLINE_MIN_HEADINGS;
  const minLevel = Math.min(...outline.map((o) => o.level));
  const jump = (block: number): void => {
    wrapRef.current?.querySelector(`[data-md-block="${block}"]`)?.scrollIntoView({ block: 'start' });
  };
  return (
    <div ref={wrapRef} style={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>{body}</div>
      {show && (
        <nav aria-label={label} style={outlineStyle}>
          <p style={outlineTitleStyle}>{label}</p>
          {outline.map((o) => (
            <button
              key={o.block}
              type="button"
              title={o.text}
              onClick={() => jump(o.block)}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={{ ...outlineItemStyle, paddingLeft: space.sm + (o.level - minLevel) * 12 }}
            >
              {o.text}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

function renderBlocks(blocks: Block[], ctx: Ctx, top = false): ReactNode {
  return blocks.map((block, i) => <Fragment key={i}>{renderBlock(block, ctx, top ? i : undefined)}</Fragment>);
}

function renderBlock(block: Block, ctx: Ctx, topIndex?: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as const;
      return (
        <Tag data-md-block={topIndex} style={ctx.heading[block.level]}>
          {renderInline(block.children, ctx)}
        </Tag>
      );
    }
    case 'paragraph':
      return <p style={paragraphStyle}>{renderInline(block.children, ctx)}</p>;
    case 'code':
      return ctx.codeBlock ? (
        <div style={{ margin: `0 0 ${space.lg}px` }}>{ctx.codeBlock({ lang: block.lang, text: block.text })}</div>
      ) : (
        <pre style={codeBlockStyle} data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote style={quoteStyle}>{renderBlocks(block.children, ctx)}</blockquote>;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} style={item.checked === null ? listItemStyle : taskItemStyle}>
          {item.checked !== null && (
            <input type="checkbox" checked={item.checked} readOnly disabled style={checkboxStyle} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>{renderBlocks(item.children, ctx)}</div>
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} style={listStyle}>
          {items}
        </ol>
      ) : (
        <ul style={listStyle}>{items}</ul>
      );
    }
    case 'table':
      return (
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                {block.head.map((cell, c) => (
                  <th key={c} style={{ ...thStyle, textAlign: block.align[c] ?? 'left' }}>
                    {renderInline(cell, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ ...tdStyle, textAlign: block.align[c] ?? 'left' }}>
                      {renderInline(cell, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr style={hrStyle} />;
  }
}

function renderInline(nodes: Inline[], ctx: Ctx): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={i}>{ctx.text ? ctx.text(node.text) : node.text}</Fragment>;
      case 'br':
        return <br key={i} />;
      case 'code':
        return (
          <code key={i} style={inlineCodeStyle}>
            {ctx.text ? ctx.text(node.text) : node.text}
          </code>
        );
      case 'em':
        return <em key={i}>{renderInline(node.children, ctx)}</em>;
      case 'strong':
        return <strong key={i}>{renderInline(node.children, ctx)}</strong>;
      case 'del':
        return <del key={i}>{renderInline(node.children, ctx)}</del>;
      case 'link': {
        // A link's label is shown as written: linking paths inside it would nest buttons.
        const label = renderInline(node.children, { ...ctx, text: undefined });
        if (isExternalHref(node.href))
          return (
            <a key={i} href={node.href} target="_blank" rel="noreferrer noopener" title={node.href} style={linkStyle}>
              {label}
            </a>
          );
        if (ctx.localLink) return <Fragment key={i}>{ctx.localLink(node.href, label)}</Fragment>;
        return (
          <span key={i} title={node.href} style={localLinkStyle}>
            {label}
          </span>
        );
      }
      case 'image':
        return (
          <span key={i} title={node.src} style={imageStyle}>
            <ImageIcon size={12} />
            {node.alt || ctx.imageLabel}
          </span>
        );
    }
  });
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const rootStyle: CSSProperties = {
  maxWidth: 820,
  padding: `${space.xl}px ${space.xl * 1.5}px ${space.xl * 2}px`,
  fontSize: fontSize.md,
  lineHeight: 1.65,
  color: token('text'),
  userSelect: 'text',
  overflowWrap: 'anywhere',
};

// A message: no reading-column padding; the bubble's line height and width rule.
const chatRootStyle: CSSProperties = {
  maxWidth: '100%',
  fontSize: fontSize.md,
  lineHeight: 1.65,
  color: token('text'),
  userSelect: 'text',
  overflowWrap: 'anywhere',
};

const headingBase: CSSProperties = { margin: `${space.xl}px 0 ${space.md}px`, fontWeight: 600, lineHeight: 1.3 };
const headingRule: CSSProperties = { paddingBottom: space.sm, borderBottom: `1px solid ${token('border')}` };
const headingStyle: Record<1 | 2 | 3 | 4 | 5 | 6, CSSProperties> = {
  1: { ...headingBase, ...headingRule, fontSize: 24 },
  2: { ...headingBase, ...headingRule, fontSize: 20 },
  3: { ...headingBase, fontSize: 17 },
  4: { ...headingBase, fontSize: fontSize.lg },
  5: { ...headingBase, fontSize: fontSize.md },
  6: { ...headingBase, fontSize: fontSize.base, color: token('textMuted') },
};

const chatHeadingBase: CSSProperties = { margin: `${space.lg}px 0 ${space.sm}px`, fontWeight: 600, lineHeight: 1.35 };
const chatHeadingStyle: Record<1 | 2 | 3 | 4 | 5 | 6, CSSProperties> = {
  1: { ...chatHeadingBase, fontSize: 18 },
  2: { ...chatHeadingBase, fontSize: 16 },
  3: { ...chatHeadingBase, fontSize: fontSize.lg },
  4: { ...chatHeadingBase, fontSize: fontSize.md },
  5: { ...chatHeadingBase, fontSize: fontSize.md },
  6: { ...chatHeadingBase, fontSize: fontSize.base, color: token('textMuted') },
};

const paragraphStyle: CSSProperties = { margin: `0 0 ${space.lg}px` };

const codeBlockStyle: CSSProperties = {
  margin: `0 0 ${space.lg}px`,
  padding: `${space.md}px ${space.lg}px`,
  background: token('surface'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.md,
  fontFamily: MONO,
  fontSize: fontSize.sm,
  lineHeight: 1.55,
  overflowX: 'auto',
  whiteSpace: 'pre',
};

const inlineCodeStyle: CSSProperties = {
  padding: '1px 5px',
  background: token('surface'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.sm,
  fontFamily: MONO,
  fontSize: '0.88em',
};

const quoteStyle: CSSProperties = {
  margin: `0 0 ${space.lg}px`,
  padding: `0 ${space.lg}px`,
  borderLeft: `3px solid ${token('borderStrong')}`,
  color: token('textMuted'),
};

const listStyle: CSSProperties = { margin: `0 0 ${space.lg}px`, paddingLeft: 24 };
const listItemStyle: CSSProperties = { margin: `${space.xs}px 0` };
const taskItemStyle: CSSProperties = {
  ...listItemStyle,
  listStyle: 'none',
  marginLeft: -20,
  display: 'flex',
  alignItems: 'flex-start',
  gap: space.sm,
};
const checkboxStyle: CSSProperties = { margin: '5px 0 0', flexShrink: 0 };

const tableWrapStyle: CSSProperties = { margin: `0 0 ${space.lg}px`, overflowX: 'auto' };
const tableStyle: CSSProperties = { borderCollapse: 'collapse', fontSize: fontSize.base };
const thStyle: CSSProperties = {
  padding: `${space.sm}px ${space.lg}px`,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
  fontWeight: 600,
};
const tdStyle: CSSProperties = { padding: `${space.sm}px ${space.lg}px`, border: `1px solid ${token('border')}` };

const hrStyle: CSSProperties = { margin: `${space.xl}px 0`, border: 'none', borderTop: `1px solid ${token('border')}` };

const linkStyle: CSSProperties = { color: token('accent'), textDecoration: 'underline', textUnderlineOffset: 2 };
const localLinkStyle: CSSProperties = { textDecoration: 'underline dotted', textUnderlineOffset: 2 };

const imageStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: space.xs,
  verticalAlign: 'middle',
  padding: '0 6px',
  border: `1px dashed ${token('borderStrong')}`,
  borderRadius: radius.sm,
  color: token('textMuted'),
  fontSize: fontSize.sm,
};

const outlineStyle: CSSProperties = {
  position: 'sticky',
  top: 0,
  width: 220,
  flexShrink: 0,
  maxHeight: '100vh',
  overflowY: 'auto',
  boxSizing: 'border-box',
  padding: `${space.xl}px ${space.lg}px ${space.xl}px 0`,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};
const outlineTitleStyle: CSSProperties = {
  margin: `0 0 ${space.sm}px`,
  paddingLeft: space.sm,
  fontSize: fontSize.xs,
  fontWeight: 600,
  color: token('textMuted'),
};
const outlineItemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: `3px ${space.sm}px`,
  border: 'none',
  borderRadius: radius.sm,
  background: 'transparent',
  color: token('textMuted'),
  font: 'inherit',
  fontSize: fontSize.sm,
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};
