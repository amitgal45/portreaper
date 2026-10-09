<script setup lang="ts">
// A quiet tooltip. Needs a TooltipProvider above it (App.vue has one).
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui";

defineProps<{ text: string }>();
</script>

<template>
  <TooltipRoot>
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        side="bottom"
        :side-offset="4"
        :collision-padding="8"
        class="z-50 max-w-64 rounded border border-neutral-200 bg-white px-2 py-1 text-[11px] leading-snug text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
      >
        {{ text }}
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
