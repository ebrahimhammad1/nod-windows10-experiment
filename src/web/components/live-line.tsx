import { useEffect, useId, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { Activity } from '../../shared/contracts';
import { Check, ChevronDown } from './icons';

const quietSeconds = (since: string) => {
  const seconds = Math.floor((Date.now() - Date.parse(since)) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
};

export function elapsedLabel(seconds: number) {
  if (seconds < 5) return '';
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min`;
}

function useQuietSeconds(since: string, enabled: boolean) {
  const [seconds, setSeconds] = useState(() => quietSeconds(since));
  useEffect(() => {
    setSeconds(quietSeconds(since));
    if (!enabled) return;
    const timer = setInterval(() => setSeconds(quietSeconds(since)), 1000);
    return () => clearInterval(timer);
  }, [since, enabled]);
  return enabled ? seconds : 0;
}

export function LiveLine({
  item,
  quiet = true,
  history = true,
  clipped = false,
}: {
  item?: Activity;
  quiet?: boolean;
  history?: boolean;
  clipped?: boolean;
}) {
  const labelId = useId();
  const label = useRef<HTMLSpanElement>(null);
  const step = item?.step?.trim();
  const site = item?.doing === 'tool' ? item.site : null;
  const total = useQuietSeconds(item?.since ?? '', quiet && Boolean(item));
  const sinceUpdate = useQuietSeconds(item?.quietSince ?? '', quiet && Boolean(item));
  const elapsed = elapsedLabel(total);
  const stalled = sinceUpdate >= 30 ? `no update for ${elapsedLabel(sinceUpdate)}` : '';
  const work =
    item?.doing === 'tool'
      ? item.tool
      : item?.doing === 'model'
        ? item.model
          ? `Waiting for ${item.model}`
          : 'Waiting for the model'
        : undefined;
  const described = step || (site && `Using ${site}`) || work;
  const queued = item?.doing === 'queued';
  const meta = [step ? site || work : null, elapsed || null, stalled || null]
    .filter(Boolean)
    .join(' · ');
  useEffect(() => {
    if (label.current) label.current.title = described ? (label.current.textContent ?? '') : '';
  }, [described, meta]);
  const current = (
    <span className="live-line-current" id={labelId} role="status" ref={label}>
      {described ? (
        <Markdown allowedElements={[]} unwrapDisallowed>
          {described}
        </Markdown>
      ) : queued ? (
        'Waiting to start…'
      ) : (
        'Working…'
      )}
      {meta && ` · ${meta}`}
    </span>
  );
  const recent = item?.recent ?? [];
  if (!history || !item || !(recent.length || (clipped && described))) return current;
  return (
    <details className="live-line" key={item.turnId}>
      <summary aria-labelledby={labelId}>
        {current}
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      {recent.length > 0 && (
        <ol aria-label="Recent completed activity">
          {recent.map((entry) => (
            <li key={entry.id}>
              <Check size={12} aria-hidden="true" />
              <span>
                <Markdown allowedElements={[]} unwrapDisallowed>
                  {entry.summary}
                </Markdown>
                {entry.site && <span className="live-line-site"> · {entry.site}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
