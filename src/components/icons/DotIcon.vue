<script setup lang="ts">
// dot: the Running status, and Protected in its blue. Filled, no stroke. The mock-up's symbol, verbatim (spec item 8).
import IconBase from "./IconBase.vue";
import type { IconProps } from "./types";

defineProps<IconProps>();
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
  </IconBase>
</template>
