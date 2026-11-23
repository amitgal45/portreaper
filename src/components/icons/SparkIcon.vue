<script setup lang="ts">
// spark: Local AI, and the AI status in its purple. The mock-up's symbol, verbatim (spec item 8).
import IconBase from "./IconBase.vue";
import type { IconProps } from "./types";

defineProps<IconProps>();
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M11 5c.5 3.4 2.1 5 5.5 5.5-3.4.5-5 2.1-5.5 5.5-.5-3.4-2.1-5-5.5-5.5 3.4-.5 5-2.1 5.5-5.5z" />
    <path d="M18 14.5v4M16 16.5h4" />
  </IconBase>
</template>
