<script setup lang="ts">
// The app icon in small, for the window and the strip (the sidebar's brand row, the first-run
// card, Settings → About, the ⌘⇧K strip's header): design/icon.svg's plate, its frosted echo
// plate and its two sheared brackets, the left one warm and the right one cool (lib/app-icon.ts).
// No drop shadow, glow, grid or rim: at 14 to 28 px they are only blur. The plate is fixed in
// light and dark alike, like the Dock icon. Decorative: hidden from assistive technology, the name
// sits beside it. (Not to be confused with a row's brand mark, `FrameworkIcon`: a stack's logo.)
//
// The ids are per instance (useId): two marks on one page must not share a gradient.
// The colours and the geometry come from lib/app-icon.ts.
import { useId } from "vue";
import { APP_ICON, ECHO, LEFT_BRACKET, RIGHT_BRACKET } from "../lib/app-icon";

const id = useId();
const plate = `${id}-plate`;
const warm = `${id}-warm`;
const cool = `${id}-cool`;
const glass = `${id}-glass`;
</script>

<template>
  <svg data-app-mark viewBox="100 100 824 824" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient :id="plate" x1="15%" y1="8%" x2="85%" y2="95%">
        <stop offset="0%" :stop-color="APP_ICON.plate[0]" />
        <stop offset="45%" :stop-color="APP_ICON.plate[1]" />
        <stop offset="100%" :stop-color="APP_ICON.plate[2]" />
      </linearGradient>
      <linearGradient :id="warm" x1="10%" y1="0%" x2="90%" y2="100%">
        <stop offset="0%" :stop-color="APP_ICON.warm[0]" />
        <stop offset="45%" :stop-color="APP_ICON.warm[1]" />
        <stop offset="100%" :stop-color="APP_ICON.warm[2]" />
      </linearGradient>
      <linearGradient :id="cool" x1="15%" y1="0%" x2="85%" y2="100%">
        <stop offset="0%" :stop-color="APP_ICON.cool[0]" />
        <stop offset="45%" :stop-color="APP_ICON.cool[1]" />
        <stop offset="100%" :stop-color="APP_ICON.cool[2]" />
      </linearGradient>
      <linearGradient :id="glass" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" :stop-color="APP_ICON.glass[0]" stop-opacity="0.16" />
        <stop offset="100%" :stop-color="APP_ICON.glass[1]" stop-opacity="0.06" />
      </linearGradient>
    </defs>
    <rect x="100" y="100" width="824" height="824" rx="185" :fill="`url(#${plate})`" />
    <rect v-bind="ECHO" :fill="`url(#${glass})`" />
    <path :d="LEFT_BRACKET" :fill="`url(#${warm})`" />
    <path :d="RIGHT_BRACKET" :fill="`url(#${cool})`" />
  </svg>
</template>
