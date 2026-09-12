import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Side drawer on desktop, bottom sheet on mobile.
 *
 * Native `<dialog>` so focus trapping, Escape-to-close, inertness of the page behind and the
 * backdrop all come from the platform rather than being re-implemented (badly) in React. Advanced
 * detail lives in here precisely so it is *not* on the main screen: the trade surface stays
 * readable and the protocol internals are one deliberate click away.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // `close` fires for Escape and for the backdrop click below, so one listener covers both and
    // the parent's state can never drift from the dialog's actual state.
    const onCloseEvent = () => onClose();
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) dialog.close();
    };
    dialog.addEventListener("close", onCloseEvent);
    dialog.addEventListener("click", onClick);
    return () => {
      dialog.removeEventListener("close", onCloseEvent);
      dialog.removeEventListener("click", onClick);
    };
  }, [onClose]);

  return (
    <dialog className="drawer" ref={ref} aria-label={title}>
      <div className="drawer-inner">
        <header className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <span className="label">{subtitle}</span>}
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </dialog>
  );
}

/** Label/value row used throughout the drawers. Keeps every detail list on one grid. */
export function DetailRow({
  k,
  v,
  mono,
  hint,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="drow">
      <span className="drow-k" title={hint}>
        {k}
      </span>
      <span className={`drow-v${mono ? " mono" : ""}`}>{v}</span>
    </div>
  );
}
