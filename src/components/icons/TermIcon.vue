<script setup lang="ts">
// term: Dev servers. The mock-up's symbol, verbatim (spec item 8).
import IconBase from "./IconBase.vue";
import type { IconProps } from "./types";

defineProps<IconProps>();
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
    <path d="M7.5 10l2.5 2.25-2.5 2.25M12.5 14.5h4" />
  </IconBase>
</template>
