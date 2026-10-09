import { ref } from "vue";

export type ToastKind = "info" | "error";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

export interface UseToastsOptions {
  /** How long a toast stays. */
  durationMs?: number;
  /** How many stack; the oldest leaves first. */
  max?: number;
}

let nextId = 1;

/** Outcomes of a kill and the other row actions. Four seconds each, three at most. */
export function useToasts(options: UseToastsOptions = {}) {
  const durationMs = options.durationMs ?? 4000;
  const max = options.max ?? 3;
  const toasts = ref<Toast[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function dismiss(id: number) {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function push(message: string, kind: ToastKind = "info"): Toast {
    const toast: Toast = { id: nextId++, message, kind };
    toasts.value = [...toasts.value, toast];
    while (toasts.value.length > max) {
      const oldest = toasts.value[0];
      if (oldest) dismiss(oldest.id);
    }
    timers.set(
      toast.id,
      setTimeout(() => dismiss(toast.id), durationMs),
    );
    return toast;
  }

  function clear() {
    for (const t of [...toasts.value]) dismiss(t.id);
  }

  return { toasts, push, dismiss, clear };
}

export type Toasts = ReturnType<typeof useToasts>;
