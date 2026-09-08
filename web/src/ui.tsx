import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Link } from "wouter";

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "quiet";
type Size = "md" | "sm";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-ctl font-medium transition-colors duration-[120ms] ease-out disabled:cursor-not-allowed disabled:opacity-60";
const BUTTON_VARIANT: Record<Variant, string> = {
  primary: "bg-accent-primary text-content-on-accent hover:bg-accent-hover",
  secondary: "border border-border-strong bg-surface-raised text-content-default hover:bg-surface-sunken",
  danger: "bg-status-critical text-content-on-accent hover:opacity-90",
  quiet: "text-content-muted hover:bg-surface-sunken hover:text-content-default",
};
const BUTTON_SIZE: Record<Size, string> = {
  md: "h-9 px-3.5 text-sm",
  sm: "h-7 px-2.5 text-xs",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant | undefined;
  size?: Size | undefined;
  busy?: boolean | undefined;
}

export function Button({ variant = "secondary", size = "md", busy = false, className, disabled, type = "button", children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(BUTTON_BASE, BUTTON_SIZE[size], BUTTON_VARIANT[variant], className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

interface LinkButtonProps {
  href: string;
  variant?: Variant | undefined;
  size?: Size | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function LinkButton({ href, variant = "secondary", size = "md", className, children }: LinkButtonProps) {
  return (
    <Link href={href} className={cx(BUTTON_BASE, BUTTON_SIZE[size], BUTTON_VARIANT[variant], className)}>
      {children}
    </Link>
  );
}

export function TextLink({ href, children, className }: { href: string; children: ReactNode; className?: string | undefined }) {
  return (
    <Link href={href} className={cx("font-medium text-content-default underline decoration-border-strong underline-offset-2 hover:decoration-accent-primary", className)}>
      {children}
    </Link>
  );
}

const CONTROL =
  "w-full rounded-ctl border border-border-strong bg-surface-raised px-3 text-[15px] text-content-default placeholder:text-content-faint aria-invalid:border-status-critical disabled:opacity-60";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL, "h-9", className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(CONTROL, "h-9", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(CONTROL, "py-2 leading-normal", className)} {...rest} />;
}

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
}

export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  return (
    <label className={cx("inline-flex items-center gap-2 text-sm", className)}>
      <input type="checkbox" className="size-4 accent-accent-primary" {...rest} />
      <span>{label}</span>
    </label>
  );
}

interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
}

export function Radio({ label, className, ...rest }: RadioProps) {
  return (
    <label className={cx("inline-flex items-center gap-2 text-sm", className)}>
      <input type="radio" className="size-4 accent-accent-primary" {...rest} />
      <span>{label}</span>
    </label>
  );
}

interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  error?: string | null | undefined;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-status-critical" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-content-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Fieldset({ legend, hint, children }: { legend: string; hint?: string | undefined; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{legend}</legend>
      {hint ? <p className="-mt-1 text-sm text-content-muted">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

type NoticeKind = "info" | "error" | "ok";
const NOTICE: Record<NoticeKind, string> = {
  info: "bg-surface-sunken text-content-default",
  error: "bg-status-critical-soft text-status-critical",
  ok: "bg-status-ok-soft text-status-ok",
};

export function Notice({ kind = "info", children, action, className }: { kind?: NoticeKind | undefined; children: ReactNode; action?: ReactNode; className?: string | undefined }) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className={cx("flex items-start justify-between gap-4 rounded-ctl px-3 py-2 text-sm", NOTICE[kind], className)}>
      <div className="min-w-0 break-words">{children}</div>
      {action}
    </div>
  );
}

interface PanelProps {
  title?: string | undefined;
  description?: ReactNode;
  actions?: ReactNode;
  bleed?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function Panel({ title, description, actions, bleed = false, className, children }: PanelProps) {
  return (
    <section className={cx("rounded-ctl bg-surface-raised", className)}>
      {title ? (
        <header className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 text-sm text-content-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={bleed ? "overflow-x-auto" : cx("px-4 pb-4", title ? "" : "pt-4")}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description ? <div className="mt-1 text-sm text-content-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

type Tone = "neutral" | "ok" | "critical" | "accent";
const PILL: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-content-muted",
  ok: "bg-status-ok-soft text-status-ok",
  critical: "bg-status-critical-soft text-status-critical",
  accent: "bg-accent-soft text-accent-primary",
};

export function Pill({ tone = "neutral", title, children }: { tone?: Tone | undefined; title?: string | undefined; children: ReactNode }) {
  return (
    <span title={title} className={cx("inline-flex items-center whitespace-nowrap rounded-ctl px-1.5 py-0.5 text-xs font-medium", PILL[tone])}>
      {children}
    </span>
  );
}

export function Mono({ children, className, title }: { children: ReactNode; className?: string | undefined; title?: string | undefined }) {
  return (
    <code title={title} className={cx("font-mono text-[13px]", className)}>
      {children}
    </code>
  );
}

export function InkBlock({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <pre className={cx("overflow-x-auto rounded-ctl bg-surface-ink px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-content-on-ink", className)}>
      {children}
    </pre>
  );
}

export function CopyButton({ value, label = "Copy", size = "sm" }: { value: string; label?: string | undefined; size?: Size | undefined }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = (): void => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setState("failed");
      return;
    }
    clipboard.writeText(value).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  return (
    <Button size={size} onClick={copy} aria-live="polite">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed, select the text" : label}
    </Button>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean | undefined;
  error?: string | null | undefined;
  children: ReactNode;
}

export function ConfirmDialog({ open, title, confirmLabel, onConfirm, onClose, busy = false, error, children }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-ctl border-0 bg-surface-raised p-5 text-content-default shadow-overlay"
    >
      {open ? (
        <>
          <h2 className="text-base font-semibold">{title}</h2>
          <div className="mt-2 text-sm text-content-muted">{children}</div>
          {error ? (
            <Notice kind="error" className="mt-3">
              {error}
            </Notice>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="quiet" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={onConfirm} busy={busy}>
              {confirmLabel}
            </Button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-content-muted">
      <p className="max-w-md">{children}</p>
      {action}
    </div>
  );
}

export function TableMessage({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-10 text-center text-sm text-content-muted">
        {children}
      </td>
    </tr>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Notice
      kind="error"
      action={
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {message}
    </Notice>
  );
}

export function Wordmark({ className }: { className?: string | undefined }) {
  return (
    <span className={cx("font-semibold tracking-tight", className)}>
      key<span className="text-accent-primary">gate</span>
    </span>
  );
}
