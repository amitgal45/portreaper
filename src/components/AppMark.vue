<script setup lang="ts">
// The app icon in small, for the window and the strip (the sidebar's brand row, the first-run
// card, the ⌘⇧K strip's header): design/icon.svg's plate and glyph, the socket cut in two, the
// left piece Neon Amber to Signal Coral, the right Azure to Violet, the opening a glass panel.
// No bloom: at 14 to 28 px it is only blur. The plate is a fixed obsidian in light and dark
// alike, like the Dock icon. Decorative: hidden from assistive technology, the name sits beside it.
// (Not to be confused with a row's brand mark, `FrameworkIcon`: that one is a stack's logo.)
//
// The ids are per instance (useId): two marks on one page must not share a gradient or a mask.
// The colours and the geometry come from lib/app-icon.ts; the mask stays black and white.
import { useId } from "vue";
import { APP_ICON, CUT, LEFT, OPENING, RIGHT, SOCKET } from "../lib/app-icon";

const id = useId();
const cut = `${id}-cut`;
const left = `${id}-left`;
const right = `${id}-right`;
const warm = `${id}-warm`;
const cool = `${id}-cool`;
</script>

<template>
  <svg data-app-mark viewBox="100 100 824 824" aria-hidden="true" focusable="false">
    <defs>
      <mask :id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
        <rect width="1024" height="1024" fill="#fff" />
        <path :d="CUT" fill="none" stroke="#000" stroke-width="88" />
      </mask>
      <clipPath :id="left" clipPathUnits="userSpaceOnUse">
        <path :d="LEFT" />
      </clipPath>
      <clipPath :id="right" clipPathUnits="userSpaceOnUse">
        <path :d="RIGHT" />
      </clipPath>
      <linearGradient :id="warm" gradientUnits="userSpaceOnUse" x1="184" y1="234" x2="430" y2="790">
        <stop offset="0" :stop-color="APP_ICON.warm[0]" />
        <stop offset="1" :stop-color="APP_ICON.warm[1]" />
      </linearGradient>
      <linearGradient :id="cool" gradientUnits="userSpaceOnUse" x1="840" y1="234" x2="560" y2="790">
        <stop offset="0" :stop-color="APP_ICON.cool[0]" />
        <stop offset="1" :stop-color="APP_ICON.cool[1]" />
      </linearGradient>
    </defs>
    <rect x="100" y="100" width="824" height="824" rx="185" :fill="APP_ICON.plate" />
    <g :mask="`url(#${cut})`">
      <path :d="OPENING" :fill="APP_ICON.glass" fill-opacity="0.06" />
      <path :d="SOCKET" fill-rule="evenodd" :fill="`url(#${warm})`" :clip-path="`url(#${left})`" />
      <path :d="SOCKET" fill-rule="evenodd" :fill="`url(#${cool})`" :clip-path="`url(#${right})`" />
    </g>
  </svg>
</template>
