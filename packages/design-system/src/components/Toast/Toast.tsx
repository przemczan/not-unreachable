import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon, type IconName } from "../Icon/index.ts";

/** How long a toast stays by default, in ms. */
const DEFAULT_DURATION = 5000;

export type ToastTone = "neutral" | "info" | "success" | "warning" | "danger";

const toneIcon: Record<ToastTone, { readonly name: IconName; readonly className: string }> = {
  neutral: { name: "info", className: "text-fg-2" },
  info: { name: "info", className: "text-info-fg" },
  success: { name: "circle-check", className: "text-success-fg" },
  warning: { name: "triangle-alert", className: "text-warning-fg" },
  danger: { name: "circle-alert", className: "text-danger-fg" },
};

export interface ToastProps {
  /**
   * The icon's colour: `success`, `danger` and so on; the card itself stays neutral.
   * @defaultValue "neutral"
   */
  tone?: ToastTone;
  /** Past tense, object first: "Session signed out", "Settings saved". */
  title?: React.ReactNode;
  /** A line under the title. */
  description?: React.ReactNode;
  /** A Button under the text, such as "Undo" for a reversible action. */
  action?: React.ReactNode;
  /** Shows a "Dismiss" button that calls it. */
  onClose?: () => void;
  className?: string;
}

interface ToastCardProps extends ToastProps {
  /** An `<output>` (a polite `status`) when it stands alone; a plain `<div>` inside the provider's live region. */
  readonly live?: boolean;
}

function ToastCard({ tone = "neutral", title, description, action, onClose, className, live = false }: ToastCardProps) {
  const icon = toneIcon[tone];
  const Root = live ? "output" : "div";
  return (
    <Root
      className={cn(
        "flex w-90 max-w-full items-start gap-2.5 rounded-card border border-solid border-border bg-surface-raised px-3.5 py-3 shadow-floating",
        className,
      )}
    >
      <span className={cn("mt-0.5 grid", icon.className)}>
        <Icon name={icon.name} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        {/* type-body-sm sets the 13px size; the weight goes on the text, as the font shorthand would override it. */}
        {title != null && <p className="m-0 type-body-sm font-semibold text-fg-1">{title}</p>}
        {description != null && <p className="m-0 type-body-sm text-fg-2">{description}</p>}
        {action != null && <div className="mt-2">{action}</div>}
      </div>
      {onClose && (
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onClose}
          className="grid flex-none cursor-pointer rounded-badge border-0 bg-transparent p-0.5 text-fg-3 hover:text-fg-1 focus-visible:shadow-focus"
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </Root>
  );
}

/**
 * One toast card, an `<output>` (a polite `status`). Screens normally show toasts with `useToast()` under a
 * ToastProvider; render this directly only for previews or a toast of your own placing.
 *
 * @example
 * <Toast tone="success" title="Session signed out" onClose={dismiss} />
 */
export function Toast(props: ToastProps) {
  return <ToastCard {...props} live />;
}

export interface ToastOptions {
  /** @defaultValue "neutral" */
  tone?: ToastTone;
  /** Past tense, object first: "Session signed out". */
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A Button such as "Undo"; dismiss the toast in its handler if it should go. */
  action?: React.ReactNode;
  /**
   * How long it stays, in ms; 0 keeps it until dismissed.
   * @defaultValue 5000
   */
  duration?: number;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (toast: ToastOptions) => string;
  /** Removes a toast early. */
  dismiss: (id: string) => void;
}

interface QueuedToast extends ToastOptions {
  readonly id: string;
}

const ToastContext = createContext<ToastApi | null>(null);

function QueuedToastCard({ toast, onDismiss }: { readonly toast: QueuedToast; readonly onDismiss: (id: string) => void }) {
  const { id, duration = DEFAULT_DURATION, ...card } = toast;
  useEffect(() => {
    if (duration <= 0) return undefined;
    const timer = setTimeout(() => onDismiss(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, onDismiss]);
  return (
    <div>
      <ToastCard {...card} onClose={() => onDismiss(id)} />
    </div>
  );
}

export interface ToastProviderProps {
  children?: React.ReactNode;
}

/**
 * Holds the app's toasts and shows them bottom-right, newest last, above the page (`z-toast`).
 * The stack is one polite live region (an `<output>`, role `status`) that exists before any toast arrives, so
 * screen readers announce each new one. Wrap the app in it once; screens call `useToast()`.
 *
 * @example
 * <ToastProvider><App /></ToastProvider>
 * // in a screen
 * const toast = useToast();
 * toast.show({ tone: "success", title: "Session signed out" });
 */
export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<QueuedToast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback((toast: ToastOptions) => {
    nextId.current += 1;
    const id = `toast-${nextId.current}`;
    setToasts((current) => [...current, { ...toast, id }]);
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <section aria-label="Notifications" className="pointer-events-none fixed right-6 bottom-6 z-toast max-w-full">
        <output className="flex flex-col gap-2 *:pointer-events-auto">
          {toasts.map((toast) => (
            <QueuedToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </output>
      </section>
    </ToastContext>
  );
}

/** Shows toasts from a screen; it needs a ToastProvider above it. */
export function useToast(): ToastApi {
  const api = use(ToastContext);
  if (api === null) throw new Error("useToast() needs a <ToastProvider> above it.");
  return api;
}
