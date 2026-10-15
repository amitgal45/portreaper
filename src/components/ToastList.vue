<script setup lang="ts">
// The outcomes: cards at the bottom right of the main column, between the table and the status
// line, in the flow rather than over the rows. The table gives up exactly the stack's height
// while toasts are up, so a toast never covers a row's Kill. Click one to dismiss it early.
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
    class="flex shrink-0 flex-col items-end gap-1.5 border-t border-line bg-canvas px-4 py-2 empty:hidden"
  >
    <button
      v-for="toast in toasts"
      :key="toast.id"
      type="button"
      class="relative w-72 max-w-full overflow-hidden rounded-lg border border-line bg-surface py-2 pr-3 pl-4 text-left text-[12px] leading-snug shadow-sm before:absolute before:inset-y-0 before:left-0 before:w-[3px]"
      :class="toast.kind === 'error' ? 'text-red-ink before:bg-red' : 'text-ink before:bg-green'"
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
