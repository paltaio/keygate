import type { Upstream } from "./api.ts";
import { formatDateTime, formatRelative, hintsSummary } from "./format.ts";
import { Mono, Pill } from "./ui.tsx";

/** Which credential (or pool) an upstream serves with right now. */
export function CredentialCell({ upstream, now }: { upstream: Upstream; now: number }) {
  if (upstream.strategy === "round_robin") {
    if (upstream.usable_key_count === 0) {
      return (
        <div>
          <Pill tone="critical">Empty pool</Pill>
          <p className="mt-1 text-xs text-content-muted">Requests get 503 until a credential is enabled.</p>
        </div>
      );
    }
    return (
      <div>
        <p>Pool of {upstream.usable_key_count}</p>
        <p className="text-xs text-content-muted">Round robin across enabled credentials.</p>
      </div>
    );
  }
  const key = upstream.active_key;
  if (!key) {
    return (
      <div>
        <Pill tone="critical">No usable credential</Pill>
        <p className="mt-1 text-xs text-content-muted">Requests get 503 until a credential is active and enabled.</p>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <p className="truncate" title={key.label}>
        {key.label}
      </p>
      <p className="truncate">
        <Mono className="text-content-muted" title={hintsSummary(key.hints)}>
          {hintsSummary(key.hints)}
        </Mono>
      </p>
      {key.missing.length ? (
        <p className="mt-1">
          <Pill tone="critical">Missing: {key.missing.join(", ")}</Pill>
          <span className="ml-1.5 text-xs text-content-muted">Requests get 503 until filled in.</span>
        </p>
      ) : null}
      {key.failing_at ? (
        <p className="mt-1">
          <Pill tone="critical" title={formatDateTime(key.failing_at)}>
            Rejected with {key.failing_status ?? "?"}, {formatRelative(key.failing_at, now)}
          </Pill>
        </p>
      ) : null}
    </div>
  );
}
