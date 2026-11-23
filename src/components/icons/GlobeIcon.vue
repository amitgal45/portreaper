<script setup lang="ts">
// globe: Public on LAN, and the Public status. The mock-up's symbol, verbatim (spec item 8).
import IconBase from "./IconBase.vue";
import type { IconProps } from "./types";

defineProps<IconProps>();
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <circle cx="12" cy="16.5" r="1.5" />
    <path d="M8.5 13a5 5 0 0 1 7 0M5.5 10a9 9 0 0 1 13 0" />
    <path d="M3 20.5h18" />
  </IconBase>
</template>
