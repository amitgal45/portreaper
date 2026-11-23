<script setup lang="ts">
// clock: the Taskline (a timeline: two filled stops on a rail). The mock-up's symbol, verbatim (spec item 8).
import IconBase from "./IconBase.vue";
import type { IconProps } from "./types";

defineProps<IconProps>();
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M5 4v16" />
    <circle cx="5" cy="7" r="1.5" fill="currentColor" />
    <circle cx="5" cy="17" r="1.5" fill="currentColor" />
    <path d="M10 7h10M10 17h7M10 12h4" />
  </IconBase>
</template>
