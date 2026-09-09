import { Plus, Xmark } from "iconoir-react";
import { PLACEMENT_TYPES, type Placement, type PlacementType } from "./api.ts";
import { PLACEMENT_NAME_HINT, PLACEMENT_TYPE_LABEL, placeholderNames } from "./format.ts";
import { MAX_PLACEMENTS, PLACEMENT_PRESETS, placementFieldId, type PlacementErrors } from "./placement-rules.ts";
import { Button, Input, Mono, Select } from "./ui.tsx";

interface Props {
  placements: Placement[];
  errors: PlacementErrors;
  onChange: (next: Placement[]) => void;
}

/** Rows of location / name / value template, with prefill buttons and the list of values they need. */
export function PlacementsEditor({ placements, errors, onChange }: Props) {
  const setRow = (index: number, patch: Partial<Placement>): void => onChange(placements.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const names = placeholderNames(placements);

  return (
    <div className="@container flex flex-col gap-3">
      <p className="text-sm text-content-muted">
        Where credential values go on each request. Write <Mono>{"{{name}}"}</Mono> where a value belongs; text outside the braces is sent as-is.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-content-muted">Prefill:</span>
        {PLACEMENT_PRESETS.map((preset) => (
          <Button key={preset.label} size="sm" onClick={() => onChange(preset.placements.map((p) => ({ ...p })))}>
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {placements.map((p, i) => {
          const rowError = errors.rows[i];
          return (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-2 @[40rem]:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,2fr)_auto]">
                <Select aria-label={`Placement ${i + 1} location`} value={p.type} onChange={(e) => setRow(i, { type: e.target.value as PlacementType })}>
                  {PLACEMENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PLACEMENT_TYPE_LABEL[t]}
                    </option>
                  ))}
                </Select>
                <Input
                  id={placementFieldId(i, "name")}
                  aria-label={`Placement ${i + 1} name`}
                  mono
                  placeholder={PLACEMENT_NAME_HINT[p.type]}
                  value={p.name}
                  onChange={(e) => setRow(i, { name: e.target.value })}
                  aria-invalid={rowError ? true : undefined}
                  spellCheck={false}
                />
                <Input
                  id={placementFieldId(i, "value")}
                  aria-label={`Placement ${i + 1} value template`}
                  mono
                  className="@max-[40rem]:col-span-2"
                  placeholder="Bearer {{token}}"
                  value={p.value}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                  aria-invalid={rowError ? true : undefined}
                  spellCheck={false}
                />
                <Button variant="quiet" className="@max-[40rem]:col-span-2 @max-[40rem]:justify-self-start" onClick={() => onChange(placements.filter((_, j) => j !== i))} disabled={placements.length <= 1} aria-label={`Remove placement ${i + 1}`}>
                  <Xmark aria-hidden />
                  Remove
                </Button>
              </div>
              {rowError ? (
                <p className="text-sm text-status-critical" role="alert">
                  {rowError}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {errors.list ? (
        <p className="text-sm text-status-critical" role="alert">
          {errors.list}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button id="upstream-add-placement" size="sm" onClick={() => onChange([...placements, { type: "header", name: "", value: "" }])} disabled={placements.length >= MAX_PLACEMENTS}>
          <Plus aria-hidden />
          Add placement
        </Button>
        {placements.length >= MAX_PLACEMENTS ? <span className="text-sm text-content-muted">Up to {MAX_PLACEMENTS} placements.</span> : null}
      </div>
      <p className="text-sm text-content-muted">
        {names.length === 0 ? (
          "No placeholders above, so every placement is sent as a constant and credentials hold nothing."
        ) : (
          <>
            Each <Mono>{"{{name}}"}</Mono> above is a value every credential can hold: <Mono>{names.join(", ")}</Mono>
          </>
        )}
      </p>
    </div>
  );
}
