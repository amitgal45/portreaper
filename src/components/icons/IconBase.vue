<script setup lang="ts">
// The frame every icon of src/components/icons shares (spec item 8): the mock-up's 24 grid, drawn in
// currentColor with round caps and joins. Same props as a lucide icon (`size`, `strokeWidth`), so a
// call site can swap one for the other. Decorative: the item it sits in carries the name.
import type { IconProps } from "./types";

withDefaults(defineProps<IconProps>(), { size: 15, strokeWidth: 1.75 });
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <slot />
  </svg>
</template>
