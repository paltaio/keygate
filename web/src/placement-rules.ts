import type { Placement } from "./api.ts";

export const MAX_PLACEMENTS = 20;

export const PLACEMENT_PRESETS: { label: string; placements: Placement[] }[] = [
  { label: "Bearer header", placements: [{ type: "header", name: "Authorization", value: "Bearer {{token}}" }] },
  { label: "X-API-Key header", placements: [{ type: "header", name: "X-API-Key", value: "{{api_key}}" }] },
  { label: "api_key query", placements: [{ type: "query", name: "api_key", value: "{{api_key}}" }] },
];

export interface PlacementErrors {
  rows: Record<number, string>;
  list?: string | undefined;
}

export const NO_PLACEMENT_ERRORS: PlacementErrors = { rows: {} };

export function cleanPlacements(placements: Placement[]): Placement[] {
  return placements.map((p) => ({ type: p.type, name: p.name.trim(), value: p.value.trim() }));
}

export function validatePlacements(placements: Placement[]): PlacementErrors {
  const errors: PlacementErrors = { rows: {} };
  if (placements.length === 0) errors.list = "Add at least one placement.";
  placements.forEach((p, i) => {
    if (!p.name.trim()) errors.rows[i] = "Name the header, parameter, cookie or field.";
    else if (!p.value.trim()) errors.rows[i] = "Give the value a template, such as Bearer {{token}}.";
  });
  return errors;
}

export function placementFieldId(index: number, field: "name" | "value"): string {
  return `upstream-placement-${index}-${field}`;
}

/** Id of the first control to focus for these errors, if any. */
export function firstPlacementErrorId(errors: PlacementErrors): string | undefined {
  const row = Object.keys(errors.rows)[0];
  if (row !== undefined) return placementFieldId(Number(row), "name");
  if (errors.list) return "upstream-add-placement";
  return undefined;
}
