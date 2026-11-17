<script setup lang="ts">
// The app icon in small, for the window and the strip (the sidebar's brand row, the first-run
// card, the ⌘⇧K strip's header): design/icon.svg's plate and glyph, the socket cut in two, the
// left piece Neon Amber to Signal Coral, the right Azure to Violet, the opening a glass panel.
// No bloom: at 14 to 28 px it is only blur. The plate is a fixed obsidian in light and dark
// alike, like the Dock icon. Decorative: hidden from assistive technology, the name sits beside it.
//
// The ids are per instance (useId): two marks on one page must not share a gradient or a mask.
// The colours come from lib/brand.ts (the icon's, not tokens); the mask stays black and white.
import { useId } from "vue";
import { BRAND } from "../lib/brand";

const id = useId();
const cut = `${id}-cut`;
const left = `${id}-left`;
const right = `${id}-right`;
const warm = `${id}-warm`;
const cool = `${id}-cool`;

const SOCKET =
  "M184 258 A24 24 0 0 1 208 234 H816 A24 24 0 0 1 840 258 V646 A24 24 0 0 1 816 670 H730 V766 A24 24 0 0 1 706 790 H318 A24 24 0 0 1 294 766 V670 H208 A24 24 0 0 1 184 646 Z M280 330 V574 H390 V694 H634 V574 H744 V330 Z";
const OPENING = "M280 330 V574 H390 V694 H634 V574 H744 V330 Z";
</script>

<template>
  <svg data-brand-mark viewBox="100 100 824 824" aria-hidden="true" focusable="false">
    <defs>
      <mask :id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
        <rect width="1024" height="1024" fill="#fff" />
        <path d="M388 892 Q398 475 636 132" fill="none" stroke="#000" stroke-width="88" />
      </mask>
      <clipPath :id="left" clipPathUnits="userSpaceOnUse">
        <path d="M0 0 H680 L636 132 Q398 475 388 892 L380 1024 H0 Z" />
      </clipPath>
      <clipPath :id="right" clipPathUnits="userSpaceOnUse">
        <path d="M1024 0 H680 L636 132 Q398 475 388 892 L380 1024 H1024 Z" />
      </clipPath>
      <linearGradient :id="warm" gradientUnits="userSpaceOnUse" x1="184" y1="234" x2="430" y2="790">
        <stop offset="0" :stop-color="BRAND.warm[0]" />
        <stop offset="1" :stop-color="BRAND.warm[1]" />
      </linearGradient>
      <linearGradient :id="cool" gradientUnits="userSpaceOnUse" x1="840" y1="234" x2="560" y2="790">
        <stop offset="0" :stop-color="BRAND.cool[0]" />
        <stop offset="1" :stop-color="BRAND.cool[1]" />
      </linearGradient>
    </defs>
    <rect x="100" y="100" width="824" height="824" rx="185" :fill="BRAND.plate" />
    <path :d="OPENING" :fill="BRAND.glass" fill-opacity="0.06" />
    <g :mask="`url(#${cut})`">
      <path :d="SOCKET" fill-rule="evenodd" :fill="`url(#${warm})`" :clip-path="`url(#${left})`" />
      <path :d="SOCKET" fill-rule="evenodd" :fill="`url(#${cool})`" :clip-path="`url(#${right})`" />
    </g>
  </svg>
</template>
