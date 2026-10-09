<script setup lang="ts">
// The outcomes, bottom right, above the status line. Click one to dismiss it early.
import type { Toast } from "../composables/useToasts";

defineProps<{ toasts: Toast[] }>();
defineEmits<{ dismiss: [id: number] }>();
</script>

<template>
  <div role="status" aria-live="polite" class="pointer-events-none fixed right-3 bottom-8 z-30 flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-1.5">
    <TransitionGroup name="toast">
      <button
        v-for="toast in toasts"
        :key="toast.id"
        type="button"
        class="pointer-events-auto rounded-md border px-3 py-2 text-left text-[12px] leading-snug"
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
  </div>
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
