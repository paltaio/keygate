import { slotParts, upstreamUrls, type SlotShape } from "./format.ts";
import { CopyButton, InkBlock } from "./ui.tsx";

/** Where the provider key lands in the outgoing request. */
export function SlotPreview({ slot, className }: { slot: SlotShape; className?: string | undefined }) {
  const [before, after] = slotParts(slot);
  return (
    <InkBlock className={className}>
      {before}
      <span className="text-accent-bright">{"<provider key>"}</span>
      {after}
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
