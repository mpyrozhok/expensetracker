import type { ReactNode } from 'react';

/** Shared presentational primitives: the empty/loading/error states the spec asks for. */

export function EmptyState(props: { icon: string; title: string; body: string; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="empty">
      <span aria-hidden="true" className="empty__icon">
        {props.icon}
      </span>
      <p className="empty__title">{props.title}</p>
      <p>{props.body}</p>
      {props.action}
    </div>
  );
}

export function ErrorBanner(props: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="banner" role="alert">
      <span aria-hidden="true">⚠️</span>
      <span className="spacer">{props.message}</span>
      {props.onRetry ? (
        <button type="button" className="btn btn--secondary btn--sm" onClick={props.onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Visible loading state used by the main data blocks. */
export function LoadingBlock({ rows = 3, variant = 'row' }: { rows?: number; variant?: 'row' | 'stat' }): React.JSX.Element {
  const line = Array.from({ length: rows }, (_, index) => index);
  const className = variant === 'stat' ? 'skeleton skeleton--stat' : 'skeleton skeleton--row';
  return (
    <div className="stack" aria-busy="true" aria-live="polite" aria-label="Loading">
      {line.map((index) => (
        <div key={index} className={className} />
      ))}
    </div>
  );
}

export function Stat(props: {
  label: string;
  value: string;
  meta?: string;
  tone?: 'default' | 'over';
}): React.JSX.Element {
  const valueClass = props.tone === 'over' ? 'stat__value stat__value--over' : 'stat__value';
  return (
    <div className="stat">
      <span className="stat__label">{props.label}</span>
      <span className={valueClass}>{props.value}</span>
      {props.meta ? <span className="stat__meta">{props.meta}</span> : null}
    </div>
  );
}

export function Field(props: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <span className="field__error" role="alert">
          {props.error}
        </span>
      ) : (
        <span className="field__hint">{props.hint ?? ''}</span>
      )}
    </div>
  );
}

/**
 * The avatar URL is provider-supplied, so only absolute http(s) is accepted;
 * anything else falls back to the initials badge.
 */
export function safeAvatarUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

export function Avatar(props: { name: string; url: string | null }): React.JSX.Element {
  const letters = props.name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase();
  const safe = safeAvatarUrl(props.url);
  if (!safe) {
    return (
      <span className="avatar avatar--initials" aria-hidden="true">
        {letters}
      </span>
    );
  }
  return <img className="avatar" src={safe} alt="" referrerPolicy="no-referrer" />;
}
