/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, AlertTriangle, XCircle, X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Transient confirmation of something that already happened.
 *
 * NOT an error surface for something the user must act on — that belongs inline,
 * next to the thing that failed, where `ErrorState` and a retry live. A toast
 * that disappears is the wrong place for information someone needs.
 *
 * Each tone is a solid fill with its own verified foreground, and each carries an
 * icon as well as a colour, because `ux.md` forbids communicating state with
 * colour alone.
 */
export type ToastTone = "success" | "warning" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

const ToastContext = createContext<{
  show: (tone: ToastTone, message: string) => void;
}>({ show: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const TONES: Record<ToastTone, { className: string; icon: ReactNode }> = {
  success: {
    className: "bg-success text-success-foreground",
    icon: <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />,
  },
  warning: {
    className: "bg-warning text-warning-foreground",
    icon: <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />,
  },
  error: {
    className: "bg-destructive text-destructive-foreground",
    icon: <XCircle className="h-4 w-4 shrink-0" aria-hidden />,
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((tone: ToastTone, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    // Errors stay until dismissed: a message telling someone their save failed
    // must not vanish while they are reading it.
    if (tone !== "error") {
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
    }
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-center gap-2 rounded-lg px-3 py-2 text-sm shadow-lg",
              TONES[t.tone].className,
            )}
          >
            {TONES[t.tone].icon}
            <span>{t.message}</span>
            <IconButton
              size="sm"
              variant="ghost"
              label="Dismiss"
              icon={<X className="h-3.5 w-3.5" />}
              className="ml-1 h-6 w-6 hover:bg-black/10"
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
