<script setup lang="ts">
// gear: Settings (two sliders). The mock-up's symbol, verbatim (spec item 8).
import IconBase from "./IconBase.vue";
import type { IconProps } from "./types";

defineProps<IconProps>();
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M4 8h8.5M17.5 8H20M4 16h2.5M11.5 16H20" />
    <circle cx="15" cy="8" r="2.5" />
    <circle cx="9" cy="16" r="2.5" />
  </IconBase>
</template>
