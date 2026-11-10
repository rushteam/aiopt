// The rendered view of a Markdown file in the preview. It maps `parseMarkdown`'s data tree to
// React elements, so the file's text only ever lands in text nodes. Nothing from the file is
// inserted as HTML, and it carries no styles or scripts.
//
// - Links: only absolute http(s) targets become anchors. They open in the system browser
//   through main's window-open handler, the same way the About link does. Any other target
//   (relative, file:, javascript:, …) is shown as plain text.
// - Images are never loaded. A remote image would be a tracking request, and a relative one
//   cannot resolve here. Each image shows as its alt text with an image marker.

import { Fragment, useMemo, type CSSProperties, type ReactNode } from 'react';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { isExternalHref, parseMarkdown, type Block, type Inline } from './markdown';
import { ImageIcon } from './workbenchIcons';

export function MarkdownView({ text, imageLabel }: { text: string; imageLabel: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div style={rootStyle}>{renderBlocks(blocks, imageLabel)}</div>;
}

function renderBlocks(blocks: Block[], imageLabel: string): ReactNode {
  return blocks.map((block, i) => <Fragment key={i}>{renderBlock(block, imageLabel)}</Fragment>);
}

function renderBlock(block: Block, imageLabel: string): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as const;
      return <Tag style={headingStyle[block.level]}>{renderInline(block.children, imageLabel)}</Tag>;
    }
    case 'paragraph':
      return <p style={paragraphStyle}>{renderInline(block.children, imageLabel)}</p>;
    case 'code':
      return (
        <pre style={codeBlockStyle} data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote style={quoteStyle}>{renderBlocks(block.children, imageLabel)}</blockquote>;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} style={item.checked === null ? listItemStyle : taskItemStyle}>
          {item.checked !== null && (
            <input type="checkbox" checked={item.checked} readOnly disabled style={checkboxStyle} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>{renderBlocks(item.children, imageLabel)}</div>
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
                    {renderInline(cell, imageLabel)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ ...tdStyle, textAlign: block.align[c] ?? 'left' }}>
                      {renderInline(cell, imageLabel)}
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

function renderInline(nodes: Inline[], imageLabel: string): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>;
      case 'br':
        return <br key={i} />;
      case 'code':
        return (
          <code key={i} style={inlineCodeStyle}>
            {node.text}
          </code>
        );
      case 'em':
        return <em key={i}>{renderInline(node.children, imageLabel)}</em>;
      case 'strong':
        return <strong key={i}>{renderInline(node.children, imageLabel)}</strong>;
      case 'del':
        return <del key={i}>{renderInline(node.children, imageLabel)}</del>;
      case 'link':
        return isExternalHref(node.href) ? (
          <a key={i} href={node.href} target="_blank" rel="noreferrer noopener" title={node.href} style={linkStyle}>
            {renderInline(node.children, imageLabel)}
          </a>
        ) : (
          <span key={i} title={node.href} style={localLinkStyle}>
            {renderInline(node.children, imageLabel)}
          </span>
        );
      case 'image':
        return (
          <span key={i} title={node.src} style={imageStyle}>
            <ImageIcon size={12} />
            {node.alt || imageLabel}
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
