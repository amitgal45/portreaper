<script setup lang="ts">
// The outcomes: a band between the list and the status line, right-aligned, not an overlay. The
// list above gives up exactly the stack's height while toasts are up, so a toast never covers a
// row's ✕. Click one to dismiss it early.
import type { Toast } from "../composables/useToasts";

defineProps<{ toasts: Toast[] }>();
defineEmits<{ dismiss: [id: number] }>();
</script>

<template>
  <TransitionGroup
    tag="div"
    name="toast"
    role="status"
    aria-live="polite"
    class="flex shrink-0 flex-col items-end gap-1.5 border-t border-neutral-200 px-3 py-1.5 empty:hidden dark:border-neutral-800"
  >
    <button
      v-for="toast in toasts"
      :key="toast.id"
      type="button"
      class="w-72 max-w-full rounded-md border px-3 py-2 text-left text-[12px] leading-snug"
      :class="
        toast.kind === 'error'
          ? 'border-red-300 bg-white text-red-700 dark:border-red-900 dark:bg-neutral-800 dark:text-red-300'
          : 'border-neutral-200 bg-white text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100'
      "
      @click="$emit('dismiss', toast.id)"
    >
      {{ toast.message }}
    </button>
  </TransitionGroup>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 150ms ease, transform 150ms ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
