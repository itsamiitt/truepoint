"use client";
// Toast.tsx — quiet success/feedback toasts. Mount <ToastProvider> once at the shell root, then call useToast()
// anywhere under it to push a toast (one dot of color, auto-dismiss). Context-based; styling in primitives.css.
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../cn.ts";

type ToastTone = "default" | "success" | "error";

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: ReactNode;
  description?: ReactNode;
}

interface ToastInput {
  tone?: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  /** ms before auto-dismiss; 0 keeps it until clicked. Default 4000. */
  duration?: number;
}

export interface ToastApi {
  toast: (input: ToastInput) => void;
  success: (title: ReactNode, description?: ReactNode) => void;
  error: (title: ReactNode, description?: ReactNode) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      seq.current += 1;
      const id = seq.current;
      setItems((list) => [
        ...list,
        { id, tone: input.tone ?? "default", title: input.title, description: input.description },
      ]);
      const duration = input.duration ?? 4000;
      if (duration > 0) window.setTimeout(() => remove(id), duration);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (title, description) => toast({ tone: "success", title, description }),
      error: (title, description) => toast({ tone: "error", title, description }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {items.length > 0 ? (
        <div className="tp-ui-toaster" role="region" aria-label="Notifications">
          {items.map((t) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: click is an optional dismiss; toasts auto-expire
            // biome-ignore lint/a11y/noStaticElementInteractions: a toast is a status region, click dismisses
            <div
              key={t.id}
              className={cn("tp-ui-toast", t.tone !== "default" && `tp-ui-toast--${t.tone}`)}
              role="status"
              onClick={() => remove(t.id)}
            >
              <span className="tp-ui-toast-dot" aria-hidden />
              <div className="tp-ui-toast-body">
                <span className="tp-ui-toast-title">{t.title}</span>
                {t.description != null ? (
                  <span className="tp-ui-toast-desc">{t.description}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a <ToastProvider>");
  return ctx;
}
