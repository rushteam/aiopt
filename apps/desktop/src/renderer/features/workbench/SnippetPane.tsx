// A temporary, read-only view of a code block from a chat message that has no source file
// (pasted or typed code): the text with line numbers, never rendered as HTML or run. The text
// is the message's own and stays in memory; closing the view drops it.

import type { CSSProperties } from 'react';
import { fontSize, space, token } from '../../themes/tokens';
import type { TranslateFn } from '../../i18n';
import { CloseIcon, FileIcon } from './workbenchIcons';
import { IconButton } from './workbenchPanes';
import { lineNumbers } from './workbenchNav';

export function SnippetPane({
  text,
  lang,
  t,
  onClose,
}: {
  text: string;
  lang: string;
  t: TranslateFn;
  onClose: () => void;
}) {
  const gutter = lineNumbers(text);
  const lines = gutter.split('\n').length;
  const title = t('workbench.chat.snippetTitle');
  return (
    <section aria-label={title} style={paneStyle}>
      <div style={headerStyle}>
        <FileIcon size={14} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: space.sm }}>
          <h2 style={titleStyle}>{title}</h2>
          <span style={metaStyle}>
            {[lang, t('workbench.chat.snippetLines').replace('{{lines}}', String(lines))].filter(Boolean).join(' · ')}
          </span>
        </div>
        <IconButton label={t('workbench.explorer.closePreview')} onClick={onClose} size={24}>
          <CloseIcon />
        </IconButton>
      </div>
      {/* One scroller for gutter + text so the numbers stay aligned (lines never wrap). */}
      <div style={scrollStyle} tabIndex={0} aria-label={title}>
        <pre aria-hidden style={gutterStyle}>
          {gutter}
        </pre>
        <pre style={codeStyle}>{text}</pre>
      </div>
    </section>
  );
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const paneStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.sm,
  padding: '6px 8px 6px 12px',
  borderBottom: `1px solid ${token('border')}`,
  flexShrink: 0,
  color: token('textMuted'),
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: fontSize.base,
  fontWeight: 600,
  color: token('text'),
  whiteSpace: 'nowrap',
};

const metaStyle: CSSProperties = {
  minWidth: 0,
  fontSize: fontSize.xs,
  color: token('textMuted'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  display: 'flex',
  alignItems: 'flex-start',
  outline: 'none',
};

const preBase: CSSProperties = {
  margin: 0,
  padding: `${space.md}px 0`,
  fontFamily: MONO,
  fontSize: fontSize.sm,
  lineHeight: 1.6,
  whiteSpace: 'pre',
};

const gutterStyle: CSSProperties = {
  ...preBase,
  position: 'sticky',
  left: 0,
  flexShrink: 0,
  minHeight: '100%',
  boxSizing: 'border-box',
  padding: `${space.md}px ${space.md}px ${space.md}px ${space.lg}px`,
  textAlign: 'right',
  color: token('textMuted'),
  background: token('bg'),
  borderRight: `1px solid ${token('border')}`,
  userSelect: 'none',
};

const codeStyle: CSSProperties = {
  ...preBase,
  flex: 1,
  padding: `${space.md}px ${space.lg}px`,
  color: token('text'),
  userSelect: 'text',
  tabSize: 2,
};
