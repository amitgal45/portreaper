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
        class="z-50 max-w-64 rounded border border-edge bg-steel px-2 py-1 text-[11px] leading-snug text-ink"
      >
        {{ text }}
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
