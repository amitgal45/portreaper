<script setup lang="ts">
// zap: Zombies, and the Zombie status. The mock-up's symbol, verbatim (spec item 8).
import IconBase from "./IconBase.vue";
import type { IconProps } from "./types";

defineProps<IconProps>();
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M3.5 10h8l-8 9.5h8" />
    <path d="M14.5 4.5h6l-6 7h6" />
  </IconBase>
</template>
