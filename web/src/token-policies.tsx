import { NavArrowDown, NavArrowUp, Plus, Xmark } from "iconoir-react";
import { useState } from "react";
import type { Policy, TokenPolicy } from "./api.ts";
import { Button, Checkbox, Fieldset, Mono, Notice, Pill, Select, TextLink } from "./ui.tsx";

interface Props {
  value: TokenPolicy[];
  onChange: (next: TokenPolicy[]) => void;
  /** Every policy on the instance; null while loading. */
  policies: Policy[] | null;
  loadError: string | null;
}

/** Ordered list of attached policies with per-token switches, reordering, and an attach picker. */
export function TokenPoliciesEditor({ value, onChange, policies, loadError }: Props) {
  const [pick, setPick] = useState("");
  const byId = new Map(policies?.map((p) => [p.id, p]) ?? []);
  const available = policies?.filter((p) => !value.some((v) => v.policy_id === p.id)) ?? [];
  const picked = available.find((p) => String(p.id) === pick) ?? available[0];

  const move = (from: number, to: number): void => {
    const next = [...value];
    const [row] = next.splice(from, 1);
    if (row) next.splice(to, 0, row);
    onChange(next);
  };

  return (
    <Fieldset legend="Policies" hint="They run in this order on each request and in reverse order on each response.">
      {loadError ? <Notice kind="error">{loadError}</Notice> : null}
      {value.length ? (
        <ol className="flex flex-col divide-y divide-border-subtle rounded-ctl border border-border-subtle">
          {value.map((row, i) => {
            const policy = byId.get(row.policy_id);
            return (
              <li key={row.policy_id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                <span className="w-4 text-right text-sm text-content-muted tabular-nums">{i + 1}</span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Mono className="truncate" title={row.name}>
                    {row.name}
                  </Mono>
                  {policy && !policy.enabled ? <Pill title="Disabled on its policy page, so it does not run for any token">Policy disabled</Pill> : null}
                </span>
                <Checkbox label="Enabled" checked={row.enabled} onChange={(e) => onChange(value.map((v, j) => (j === i ? { ...v, enabled: e.target.checked } : v)))} />
                <span className="inline-flex gap-0.5">
                  <Button size="sm" variant="quiet" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${row.name} up`} title="Move up">
                    <NavArrowUp aria-hidden />
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => move(i, i + 1)} disabled={i === value.length - 1} aria-label={`Move ${row.name} down`} title="Move down">
                    <NavArrowDown aria-hidden />
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Detach ${row.name}`} title="Detach">
                    <Xmark aria-hidden />
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-content-muted">No policies attached.</p>
      )}
      {policies === null ? (
        loadError ? null : <p className="text-sm text-content-muted">Loading policies...</p>
      ) : policies.length === 0 ? (
        <p className="text-sm text-content-muted">
          No policies exist yet. <TextLink href="/policies/new">Write one</TextLink> on the policies page.
        </p>
      ) : available.length ? (
        <div className="flex max-w-md items-center gap-2">
          <Select size="sm" aria-label="Policy to attach" value={picked ? String(picked.id) : ""} onChange={(e) => setPick(e.target.value)}>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.enabled ? p.name : `${p.name} (disabled)`}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            onClick={() => {
              if (picked) onChange([...value, { policy_id: picked.id, name: picked.name, enabled: true }]);
              setPick("");
            }}
          >
            <Plus aria-hidden />
            Attach
          </Button>
        </div>
      ) : null}
    </Fieldset>
  );
}
