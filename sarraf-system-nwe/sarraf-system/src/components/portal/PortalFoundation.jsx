import { useEffect, useId, useMemo, useState } from "react";
import { portalRouteFromHash } from "./portalModel";

export function usePortalRoute(role, allowed, fallback) {
  const read = () => portalRouteFromHash(window.location.hash, role, allowed, fallback);
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const onHistory = () => setRoute(read());
    window.addEventListener("hashchange", onHistory);
    return () => window.removeEventListener("hashchange", onHistory);
  }, [role, allowed.join("|"), fallback]);

  const navigate = (next, { replace = false } = {}) => {
    const safe = allowed.includes(next) ? next : fallback;
    const hash = `#/portal/${role}/${safe}`;
    if (replace) window.history.replaceState(null, "", hash);
    else if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(safe);
  };

  return [route, navigate];
}

export function PortalFrame({ children, nav, active, onNavigate, navLabel, status }) {
  return (
    <div className="portal-frame">
      {status}
      <section className="portal-main" id="portal-content">{children}</section>
      <nav className="portal-bottom-nav" aria-label={navLabel}>
        {nav.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={active === id ? "is-active" : ""}
            aria-current={active === id ? "page" : undefined} onClick={() => onNavigate(id)}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export function PortalDataStatus({ online, stale, refreshing, updatedAt, labels, onRefresh }) {
  const state = !online ? "offline" : refreshing ? "refreshing" : stale ? "stale" : "live";
  const text = labels[state];
  return (
    <div className={`portal-data-status is-${state}`} role="status" aria-live="polite">
      <span className="portal-status-dot" aria-hidden="true" />
      <span>{text}</span>
      {updatedAt && <time dateTime={updatedAt.toISOString()}>{labels.updated} {updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
      {onRefresh && <button type="button" onClick={onRefresh} disabled={refreshing || !online}>{labels.refresh}</button>}
    </div>
  );
}

export function PortalPagedList({ items, pageSize = 20, children, moreLabel }) {
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => setLimit(pageSize), [items, pageSize]);
  const visible = useMemo(() => items.slice(0, limit), [items, limit]);
  return <>{children(visible)}{limit < items.length && (
    <button className="portal-load-more" type="button" onClick={() => setLimit((n) => n + pageSize)}>{moreLabel}</button>
  )}</>;
}

export function CopyReference({ value, label, copiedLabel }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    await navigator.clipboard.writeText(String(value));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return <span className="portal-reference" id={id} dir="ltr"><code>{value}</code><button type="button" onClick={copy}>{copied ? copiedLabel : label}</button></span>;
}
