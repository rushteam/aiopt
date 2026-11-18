// One chat transcript item (a message, a tool call, an error, a notice), shared by the
// coordinator chat and a task's worker chat. Proposal cards are drawn by the coordinator pane.
import type { CSSProperties } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import type { TranslateFn } from '../../i18n';
import type { ChatItem, TaskView } from '../../../shared/workbench';
import { StatusLabel } from './TaskStatusLabel';
import { renderTextWithTaskMentions } from './taskMentionUi';
import {
  AssistantMarkdown,
  ChatLoadingIndicator,
  UserBubble,
  UserMessageBody,
  collapsedUserText,
} from './workbenchChat';
import { estimateTextHeight } from '../../lib/virtualList';

/** A first-render height guess (px); real heights replace it once a row has rendered. */
export function estimateChatItemHeight(item: ChatItem, width: number): number {
  const perLine = Math.max(20, Math.floor(width / 9));
  switch (item.kind) {
    case 'user':
      return estimateTextHeight(collapsedUserText(item.text), Math.floor(perLine * 0.85));
    case 'assistant':
      return estimateTextHeight(item.text, perLine, 21, item.thinking ? 28 : 4);
    case 'proposal':
      return 64 + 56 * item.taskIds.length;
    case 'taskUpdate':
      return 32 + 24 * item.tasks.length;
    default:
      return 22;
  }
}

export function ChatEntry({ item, tasks, t }: { item: ChatItem; tasks: readonly TaskView[]; t: TranslateFn }) {
  switch (item.kind) {
    case 'user':
      return (
        <UserBubble t={t}>
          {item.images ? (
            <span
              style={{
                display: 'block',
                color: token('textMuted'),
                fontSize: fontSize.sm,
              }}
            >
              {t('workbench.chat.imagesAttached').replace('{{count}}', String(item.images))}
            </span>
          ) : null}
          <UserMessageBody text={item.text} t={t} renderText={(s) => renderTextWithTaskMentions(s, tasks)} />
        </UserBubble>
      );
    case 'assistant':
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: space.xs,
            maxWidth: '100%',
          }}
        >
          {item.thinking && (
            <details>
              <summary style={disclosureSummaryStyle}>{t('workbench.chat.thinking')}</summary>
              <div style={thinkingStyle}>{item.thinking}</div>
            </details>
          )}
          {item.text && <AssistantMarkdown text={item.text} t={t} done={!item.streaming} />}
          {item.streaming && item.text === '' && <ChatLoadingIndicator label={t('workbench.chat.replying')} />}
        </div>
      );
    case 'tool': {
      const state = !item.done ? 'running' : item.isError ? 'failed' : 'done';
      return (
        <details style={{ fontSize: fontSize.sm }}>
          <summary style={disclosureSummaryStyle}>
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                marginRight: space.sm,
                borderRadius: radius.pill,
                verticalAlign: 'middle',
                background:
                  state === 'failed' ? token('danger') : state === 'done' ? token('success') : token('accent'),
              }}
            />
            <code style={codeStyle}>{item.name}</code>
            <span style={{ marginLeft: space.sm }}>{t(`workbench.chat.tool.${state}`)}</span>
          </summary>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: space.xs,
              marginTop: space.xs,
            }}
          >
            {item.args && (
              <>
                <span style={{ color: token('textMuted') }}>{t('workbench.chat.tool.args')}</span>
                <div style={preStyle}>{item.args}</div>
              </>
            )}
            {item.result && (
              <>
                <span style={{ color: token('textMuted') }}>{t('workbench.chat.tool.result')}</span>
                <div style={preStyle}>{item.result}</div>
              </>
            )}
          </div>
        </details>
      );
    }
    case 'error':
      return (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: fontSize.base,
            color: token('danger'),
            overflowWrap: 'anywhere',
          }}
        >
          {t('workbench.chat.error')} {item.message}
        </p>
      );
    case 'notice':
      return (
        <p
          style={{
            margin: 0,
            textAlign: 'center',
            fontSize: fontSize.sm,
            color: token('textMuted'),
          }}
        >
          {t(`workbench.notice.${item.code}`)}
        </p>
      );
    case 'taskUpdate':
      // Sent by the app (not the user) when tasks need attention; the coordinator's reply follows.
      return (
        <div
          style={{
            ...cardStyle,
            padding: '8px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: space.xs,
          }}
        >
          <span
            style={{
              fontSize: fontSize.sm,
              fontWeight: 600,
              color: token('textMuted'),
            }}
          >
            {t('workbench.chat.taskUpdate')}
          </span>
          {item.tasks.map((task, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: space.md,
                fontSize: fontSize.base,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {task.title}
              </span>
              <StatusLabel status={task.status} t={t} />
            </div>
          ))}
        </div>
      );
    case 'proposal':
      // Drawn by ChatPane as a ProposalCard (it needs the board and the runner).
      return null;
  }
}

const cardStyle: CSSProperties = {
  border: `1px solid ${token('border')}`,
  borderRadius: radius.md,
  background: token('surface'),
  padding: space.lg,
};

const disclosureSummaryStyle: CSSProperties = {
  cursor: 'pointer',
  fontSize: fontSize.sm,
  color: token('textMuted'),
  userSelect: 'none',
};

const thinkingStyle: CSSProperties = {
  marginTop: space.xs,
  padding: `${space.xs}px 0 ${space.xs}px ${space.lg}px`,
  borderLeft: `2px solid ${token('border')}`,
  fontSize: fontSize.sm,
  lineHeight: 1.6,
  color: token('textMuted'),
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  userSelect: 'text',
};

const codeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: fontSize.xs,
  color: token('text'),
  userSelect: 'text',
};

const preStyle: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  borderRadius: radius.sm,
  background: token('surface'),
  border: `1px solid ${token('border')}`,
  fontFamily: 'ui-monospace, monospace',
  fontSize: fontSize.xs,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  userSelect: 'text',
};
