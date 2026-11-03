import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

/* Colors come from the dashboard tokens, so the editor follows the light and dark themes. */
const theme = EditorView.theme({
  "&": { color: "var(--color-content-default)", backgroundColor: "var(--color-surface-raised)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", fontVariantLigatures: "none", fontVariantNumeric: "tabular-nums", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--color-accent-primary)", padding: "8px 0", minHeight: "26rem" },
  ".cm-gutter": { minHeight: "26rem" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent-primary)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--color-accent-soft)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--color-surface-sunken) 50%, transparent)" },
  ".cm-gutters": { backgroundColor: "var(--color-surface-sunken)", color: "var(--color-content-faint)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-content-default)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--color-surface-sunken)", border: "none", color: "var(--color-content-muted)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--color-accent-soft)", outline: "1px solid var(--color-border-strong)" },
  ".cm-searchMatch": { backgroundColor: "var(--color-accent-soft)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--color-accent-bright)", color: "var(--color-surface-ink)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--color-accent-soft) 60%, transparent)" },
  ".cm-tooltip": { backgroundColor: "var(--color-surface-raised)", color: "var(--color-content-default)", border: "1px solid var(--color-border-subtle)", borderRadius: "4px" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--color-accent-soft)", color: "var(--color-content-default)" },
  ".cm-panels": { backgroundColor: "var(--color-surface-sunken)", color: "var(--color-content-default)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-border-subtle)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-border-subtle)" },
  ".cm-textfield": { backgroundColor: "var(--color-surface-raised)", border: "1px solid var(--color-border-strong)", borderRadius: "4px", color: "inherit" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--color-surface-raised)", border: "1px solid var(--color-border-strong)", borderRadius: "4px", color: "inherit" },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.modifier], color: "var(--color-accent-primary)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--color-status-ok)" },
  { tag: [tags.comment, tags.typeName, tags.className], color: "var(--color-content-muted)" },
  { tag: tags.comment, fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--color-status-critical)" },
]);

function isDark(): boolean {
  return getComputedStyle(document.documentElement).colorScheme === "dark";
}

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  labelledBy: string;
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
}

export default function CodeEditor({ id, value, onChange, labelledBy, describedBy, invalid = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const attrs = useRef(new Compartment());
  const scheme = useRef(new Compartment());
  const changed = useRef(onChange);
  const initial = useRef(value);

  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          javascript({ typescript: true }),
          theme,
          syntaxHighlighting(highlight),
          attrs.current.of([]),
          scheme.current.of(EditorView.darkTheme.of(isDark())),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;

    const syncScheme = (): void => {
      editor.dispatch({ effects: scheme.current.reconfigure(EditorView.darkTheme.of(isDark())) });
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", syncScheme);
    const observer = new MutationObserver(syncScheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      media.removeEventListener("change", syncScheme);
      observer.disconnect();
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const content: Record<string, string> = { id, "aria-labelledby": labelledBy, "aria-multiline": "true" };
    if (describedBy) content["aria-describedby"] = describedBy;
    if (invalid) content["aria-invalid"] = "true";
    view.current?.dispatch({ effects: attrs.current.reconfigure(EditorView.contentAttributes.of(content)) });
  }, [id, labelledBy, describedBy, invalid]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      ref={host}
      className={`overflow-hidden rounded-ctl border transition-[border-color,box-shadow] duration-[120ms] focus-within:ring-[3px] ${
        invalid ? "border-status-critical focus-within:ring-critical-ring" : "border-border-strong focus-within:border-accent-primary focus-within:ring-focus-ring"
      }`}
    />
  );
}
