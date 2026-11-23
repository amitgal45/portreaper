<script setup lang="ts">
// reap: the toolbar's Reap. The mock-up's symbol, verbatim (spec item 8).
import IconBase from "./IconBase.vue";
import type { IconProps } from "./types";

defineProps<IconProps>();
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M5 21 13.5 3.5" />
    <path d="M13.5 3.5c4.4 0 7.4 2.3 8 6.3-2.7-2-5.6-2.7-9.6-2.1" />
  </IconBase>
</template>
