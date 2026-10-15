<script setup lang="ts">
// A brand mark for a known stack (Next.js, Vite, NestJS, PostgreSQL, Ollama...), drawn from
// simple-icons in the brand's colour, or the text pill the slot provides when the stack is unknown.
import { computed } from "vue";
import { brandIcon, isNearBlack } from "../lib/brand-icons";
import type { PortEntry } from "../types";

const props = withDefaults(
  defineProps<{ entry: Pick<PortEntry, "framework" | "processName">; size?: number }>(),
  {
    size: 16,
  },
);

const icon = computed(() => brandIcon(props.entry));
/* Near-black brands (Next.js, Express) use the text colour so they survive dark mode. */
const fill = computed(() =>
  icon.value && !isNearBlack(icon.value.color) ? icon.value.color : "currentColor",
);
</script>

<template>
  <span
    v-if="icon"
    class="inline-flex shrink-0 items-center justify-center"
    :title="props.entry.framework ?? icon.title"
    data-testid="framework-icon"
    :data-brand="icon.title"
  >
    <svg :width="props.size" :height="props.size" viewBox="0 0 24 24" role="img" :aria-label="icon.title">
      <path :d="icon.path" :fill="fill" />
    </svg>
  </span>
  <slot v-else />
</template>
