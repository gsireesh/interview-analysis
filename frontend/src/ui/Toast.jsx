import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { cx, recall, remember } from "../lib/util.js";

/* Say something in the corner, then get out of the way.
 *
 * These used to be a full-width bar above the transcript, which pushed the text
 * down and stayed there -- a reading tool should not rearrange what you are
 * reading to tell you a file was saved. A toast leaves the page alone.
 */

//: How long a message stays. A warning outlives a confirmation, because one is
//: something to act on and the other is something to notice.
const LINGER = { info: 5000, warn: 11000, action: 15000 };

const ToastContext = createContext(null);

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast outside a <Toasts>");
  return value;
}

export function Toasts({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id, storageKey) => {
    // Dismissing comes first: remembering that it was dismissed is the part
    // that is allowed to fail, not the dismissing.
    setToasts((all) => all.map((t) => (t.id === id ? { ...t, going: true } : t)));
    if (storageKey) remember(storageKey, "dismissed");
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 180);
  }, []);

  /**
   * ``key`` marks a message worth showing once ever: it stays until dismissed,
   * and dismissing it is remembered. Everything else fades on its own.
   *
   * ``action`` puts one button in the toast -- ``{ label, onAct }``. This is
   * where an undo belongs: the moment after doing something is when you know you
   * did not mean it, and a toast is already on screen saying what happened.
   *
   * ``sticky`` leaves it on screen until the caller takes it away, for work that
   * takes seconds -- an action with no sign of progress is indistinguishable
   * from one that did nothing.
   */
  const notify = useCallback(
    (message, { kind = "info", key = null, action = null, sticky = false } = {}) => {
      if (key && recall(key) === "dismissed") return () => {};
      const id = nextId.current++;
      setToasts((all) => [...all, { id, message, kind, key, action, sticky }]);

      if (!key && !sticky) {
        const ms = action ? LINGER.action : LINGER[kind] || LINGER.info;
        setTimeout(() => dismiss(id, key), ms);
      }
      return () => dismiss(id, key);
    },
    [dismiss]
  );

  /** Say that something is happening; hand back the way to stop saying it. */
  const working = useCallback(
    (message) => notify(message, { sticky: true }),
    [notify]
  );

  const value = useMemo(() => ({ notify, working }), [notify, working]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="notices">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onClose={() => dismiss(toast.id, toast.key)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ toast, onClose }) {
  const { message, kind, action, going } = toast;
  return (
    <div
      className={cx("toast", kind === "warn" ? "toast--warn" : "toast--info", going && "toast--going")}
      role={kind === "warn" ? "alert" : "status"}
    >
      <span className="toast__mark" aria-hidden="true" />
      <span className="toast__text">{message}</span>
      {action && (
        <button
          className="toast__act"
          type="button"
          onClick={() => {
            // One press only: an undo pressed twice would work on whatever the
            // first press left behind.
            onClose();
            action.onAct();
          }}
        >
          {action.label}
        </button>
      )}
      <button className="toast__close" type="button" aria-label="Dismiss" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
