// The Workbench timeline, newest first and grouped by day: every task status change (when it
// happened, which task, what happened, how long its run had taken) and every coordinator turn
// (when it ended, what set it off, how it ended, how long it took, in which conversation).
// Clicking a task that still exists opens it; clicking a listed conversation opens it.
//
// Main records the events (see main/workbench/timeline.ts); the snapshot only carries a
// revision, and this panel refetches the list when it changes.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { disabledOpacity, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useI18n, type TranslateFn } from '../../i18n';
import { fetchTimeline, openConversation } from '../../lib/workbenchStore';
import type {
  TaskTimelineEvent,
  TimelineEvent,
  TurnTimelineEvent,
  WorkbenchSnapshot,
} from '../../../shared/workbench';
import { segmentButtonChrome, segmentedRootStyle } from '../../components/ui/controlStyles';
import { StatusLabel } from './TaskStatusLabel';
import {
  endsRun,
  formatDuration,
  groupTimelineByDay,
  matchesTimelineFilter,
  TIMELINE_FILTERS,
  timelineEventKind,
  type TimelineEventKind,
  type TimelineFilter,
} from './timelineView';

export function TimelinePanel({
  wb,
  t,
  run,
  onSelectTask,
  onOpenChat,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: (action: () => Promise<void>) => Promise<boolean>;
  onSelectTask: (id: string) => void;
  onOpenChat: () => void;
}) {
  const { locale } = useI18n();
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<TimelineFilter>('key');

  useEffect(() => {
    let alive = true;
    fetchTimeline().then(
      (list) => {
        if (!alive) return;
        setEvents(list);
        setFailed(false);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [wb.timelineRevision]);

  const liveIds = useMemo(() => new Set(wb.tasks.map((task) => task.id)), [wb.tasks]);
  const days = useMemo(
    () => groupTimelineByDay((events ?? []).filter((e) => matchesTimelineFilter(e, filter))),
    [events, filter],
  );

  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }),
    [locale],
  );
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }), [locale]);
  const fullFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }),
    [locale],
  );
  const canSwitch = wb.status === 'ready' && !wb.streaming;

  const openTurnConversation = (id: string): void => {
    const target = wb.conversations.find((c) => c.id === id);
    if (!target) return;
    if (target.current) {
      onOpenChat();
      return;
    }
    void run(() => openConversation(id)).then((ok) => {
      if (ok) onOpenChat();
    });
  };

  const taskRow = (e: TaskTimelineEvent): ReactNode => {
    const kind = timelineEventKind(e);
    return (
      <Row
        key={e.seq}
        at={e.at}
        time={timeFormat}
        full={fullFormat}
        marker={taskMarkerColor(kind)}
        label={t(`workbench.timeline.event.${kind}`)}
        subject={
          liveIds.has(e.taskId) ? (
            <LinkButton title={t('workbench.timeline.openTask')} onClick={() => onSelectTask(e.taskId)}>
              {e.title}
            </LinkButton>
          ) : (
            <span style={{ ...ellipsisStyle, color: token('textMuted') }} title={t('workbench.timeline.removed')}>
              {e.title}
            </span>
          )
        }
        meta={
          <>
            <StatusLabel status={e.status} t={t} />
            {e.runMs !== null && (
              <span>
                {t(endsRun(kind) ? 'workbench.timeline.ranFor' : 'workbench.timeline.runningFor').replace(
                  '{{duration}}',
                  formatDuration(e.runMs, locale),
                )}
              </span>
            )}
          </>
        }
      />
    );
  };

  const turnRow = (e: TurnTimelineEvent): ReactNode => {
    const conversation = e.conversationId ? wb.conversations.find((c) => c.id === e.conversationId) : undefined;
    const title = conversation ? conversation.title || t('workbench.chat.untitled') : null;
    return (
      <Row
        key={e.seq}
        at={e.at}
        time={timeFormat}
        full={fullFormat}
        marker={turnMarkerColor(e)}
        label={t(`workbench.timeline.turn.${e.outcome}`)}
        subject={
          conversation && title !== null ? (
            <LinkButton
              title={t('workbench.timeline.openConversation')}
              disabled={!canSwitch && !conversation.current}
              onClick={() => openTurnConversation(conversation.id)}
            >
              {title}
            </LinkButton>
          ) : (
            <span style={{ ...ellipsisStyle, color: token('textMuted') }}>
              {t('workbench.timeline.conversationGone')}
            </span>
          )
        }
        meta={
          <>
            <span>{t(`workbench.timeline.trigger.${e.trigger}`)}</span>
            <span>
              {t('workbench.timeline.tookFor').replace('{{duration}}', formatDuration(e.durationMs, locale))}
            </span>
          </>
        }
      />
    );
  };

  return (
    <section
      aria-label={t('workbench.timeline.title')}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <div style={toolbarStyle}>
        <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: 600 }}>{t('workbench.timeline.title')}</h2>
        <span style={{ flex: 1 }} />
        <div role="group" aria-label={t('workbench.timeline.filterLabel')} style={segmentedRootStyle}>
          {TIMELINE_FILTERS.map((opt, index) => {
            const active = filter === opt;
            return (
              <button
                key={opt}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(opt)}
                style={{
                  ...segmentButtonChrome('sm'),
                  borderLeft: index === 0 ? 'none' : `1px solid ${token('border')}`,
                  background: active ? token('accent') : 'transparent',
                  color: active ? token('accentText') : token('text'),
                  cursor: active ? 'default' : 'pointer',
                }}
              >
                {t(`workbench.timeline.filter.${opt}`)}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `${space.sm}px ${space.lg}px ${space.lg}px` }}>
        {failed ? (
          <p role="alert" style={emptyStyle}>
            {t('workbench.timeline.loadFailed')}
          </p>
        ) : events === null ? null : days.length === 0 ? (
          <p style={emptyStyle}>{t('workbench.timeline.empty')}</p>
        ) : (
          days.map((day) => (
            <div key={day.key} style={{ marginTop: space.md }}>
              <h3 style={dayStyle}>{dayFormat.format(day.at)}</h3>
              <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {day.events.map((e) => (e.kind === 'task' ? taskRow(e) : turnRow(e)))}
              </ol>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function Row({
  at,
  time,
  full,
  marker,
  label,
  subject,
  meta,
}: {
  at: number;
  time: Intl.DateTimeFormat;
  full: Intl.DateTimeFormat;
  marker: string;
  label: string;
  subject: ReactNode;
  meta: ReactNode;
}) {
  return (
    <li style={rowStyle}>
      <time dateTime={new Date(at).toISOString()} title={full.format(at)} style={timeStyle}>
        {time.format(at)}
      </time>
      <span aria-hidden style={{ ...markerStyle, background: marker }} />
      <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: space.sm, minWidth: 0 }}>
          <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>
          {subject}
        </span>
        <span style={metaStyle}>{meta}</span>
      </span>
    </li>
  );
}

function LinkButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      {...hoverBackground('transparent', token('surfaceHover'))}
      style={{ ...taskLinkStyle, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? disabledOpacity : 1 }}
    >
      {children}
    </button>
  );
}

function taskMarkerColor(kind: TimelineEventKind): string {
  if (kind === 'failed' || kind === 'blocked') return token('danger');
  if (kind === 'done' || kind === 'review') return token('success');
  if (kind === 'started' || kind === 'running' || kind === 'resumed') return token('accent');
  return token('borderStrong');
}

function turnMarkerColor(e: TurnTimelineEvent): string {
  if (e.outcome === 'error') return token('danger');
  if (e.outcome === 'done') return token('textMuted');
  return token('borderStrong');
}

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  padding: '8px 12px',
  borderBottom: `1px solid ${token('border')}`,
  flexShrink: 0,
};

const emptyStyle: CSSProperties = {
  margin: `${space.lg}px 0`,
  color: token('textMuted'),
  fontSize: fontSize.base,
};

const dayStyle: CSSProperties = {
  margin: `0 0 ${space.xs}px`,
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: token('textMuted'),
  position: 'sticky',
  top: 0,
  background: token('bg'),
  padding: `${space.xs}px 0`,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: space.md,
  padding: `${space.sm}px 0`,
  borderBottom: `1px solid ${token('border')}`,
  fontSize: fontSize.md,
  color: token('text'),
};

const timeStyle: CSSProperties = {
  width: 52,
  flexShrink: 0,
  fontVariantNumeric: 'tabular-nums',
  color: token('textMuted'),
  fontSize: fontSize.sm,
  paddingTop: 2,
};

const markerStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  flexShrink: 0,
  marginTop: 6,
};

const ellipsisStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const taskLinkStyle: CSSProperties = {
  ...ellipsisStyle,
  border: 'none',
  background: 'transparent',
  color: token('accent'),
  padding: '0 4px',
  margin: '0 -4px',
  borderRadius: radius.sm,
  font: 'inherit',
  textAlign: 'left',
};

const metaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space.md,
  fontSize: fontSize.sm,
  color: token('textMuted'),
  fontVariantNumeric: 'tabular-nums',
};
