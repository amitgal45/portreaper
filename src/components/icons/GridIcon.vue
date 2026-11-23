<script setup lang="ts">
// grid: All ports. The mock-up's symbol, verbatim (spec item 8).
import IconBase from "./IconBase.vue";
import type { IconProps } from "./types";

defineProps<IconProps>();
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M3 10.5A2.5 2.5 0 0 1 5.5 8H8V4h8v4h2.5a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
    <path d="M9 14.5v2M12 14.5v2M15 14.5v2" />
  </IconBase>
</template>
