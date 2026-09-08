import type { Placement } from "./api.ts";
import { placementPrefix, templateSegments, upstreamUrls } from "./format.ts";
import { CopyButton, InkBlock } from "./ui.tsx";

/** What the upstream receives: every placement with its placeholders shown as <name>. */
export function PlacementPreview({ placements, className }: { placements: Placement[]; className?: string | undefined }) {
  return (
    <InkBlock className={className}>
      {placements.map((p, i) => (
        <span key={i} className="block">
          {placementPrefix(p)}
          {p.value ? (
            templateSegments(p.value).map((s, j) =>
              s.placeholder ? (
                <span key={j} className="text-accent-bright">{`<${s.text}>`}</span>
              ) : (
                <span key={j}>{s.text}</span>
              ),
            )
          ) : (
            <span className="text-content-faint">(empty)</span>
          )}
        </span>
      ))}
    </InkBlock>
  );
}

/** The two addresses consumers can call for a slug. */
export function UrlForms({ slug }: { slug: string }) {
  const urls = upstreamUrls(slug);
  return (
    <div className="flex flex-col gap-2">
      {urls.map((url) => (
        <div key={url} className="flex items-center gap-2">
          <InkBlock className="min-w-0 flex-1">{url}</InkBlock>
          <CopyButton value={url.replace(/\/\.\.\.$/, "/")} />
        </div>
      ))}
    </div>
  );
}
