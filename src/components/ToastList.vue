<script setup lang="ts">
// The outcomes: a band between the list and the status line, right-aligned, not an overlay. The
// list above gives up exactly the stack's height while toasts are up, so a toast never covers a
// row's Kill. Click one to dismiss it early.
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
    class="flex shrink-0 flex-col items-end gap-1.5 border-t border-edge bg-obsidian px-3 py-1.5 empty:hidden"
  >
    <button
      v-for="toast in toasts"
      :key="toast.id"
      type="button"
      class="w-72 max-w-full rounded-md border bg-steel px-3 py-2 text-left text-[12px] leading-snug"
      :class="toast.kind === 'error' ? 'border-coral/50 text-coral' : 'border-edge text-ink'"
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
