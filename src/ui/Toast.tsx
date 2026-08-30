/* ============================================================
   sparkEditor · src/ui/Toast.tsx
   A tiny pub-sub toast manager with a live region for a11y.
   ============================================================ */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "@motion/index";
import { toastVariants } from "@motion/index";
import { Icon } from "./Icon";
import "./Toast.css";

type ToastKind = "info" | "success" | "warning" | "error";
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  duration?: number;
}

interface ToastApi {
  show: (t: Omit<Toast, "id">) => void;
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
  warning: (title: string, body?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);
let counter = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  /* Auto-dismiss timers, so unmounting cannot leave them firing setState
     on a gone component — and so dismissing a toast by hand cancels its
     timer instead of leaving it to expire against a recycled id. */
  const timersRef = useRef(new Map<number, number>());

  const remove = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>((t) => {
    const id = counter++;
    const item: Toast = { id, duration: 3200, ...t };
    setItems((xs) => [...xs, item]);
    if (item.duration && item.duration > 0) {
      timersRef.current.set(id, window.setTimeout(() => remove(id), item.duration));
    }
  }, [remove]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (title, body) => show({ kind: "success", title, body }),
    error:   (title, body) => show({ kind: "error",   title, body, duration: 5000 }),
    info:    (title, body) => show({ kind: "info",    title, body }),
    warning: (title, body) => show({ kind: "warning", title, body }),
  }), [show]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications">
        <div className="toast-stack" role="status" aria-live="polite">
          <AnimatePresence>
            {items.map((t) => (
              <motion.div
                key={t.id}
                className={`toast toast--${t.kind}`}
                variants={toastVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                layout
              >
                <span className="toast__icon">
                  <Icon name={kindIcon(t.kind)} size={16} />
                </span>
                <div className="toast__body">
                  <div className="toast__title">{t.title}</div>
                  {t.body && <div className="toast__msg">{t.body}</div>}
                </div>
                <button className="toast__close" onClick={() => remove(t.id)} aria-label="Dismiss">
                  <Icon name="close" size={12} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </Ctx.Provider>
  );
}

function kindIcon(k: ToastKind): string {
  switch (k) {
    case "success": return "check";
    case "error":   return "alert";
    case "warning": return "alert";
    case "info":
    default:        return "dot";
  }
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast must be used within <ToastProvider />");
  return v;
}
