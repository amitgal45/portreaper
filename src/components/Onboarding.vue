<script setup lang="ts">
// The first-run card at the top of the Studio (WP-17b): where the app lives (the menu bar), the
// one shortcut, and the Start at login choice with its toggle, then Got it. App.vue shows it
// while `settings.onboardingDone` is false; Got it stores the flag and the card never comes back.
import { SwitchRoot, SwitchThumb } from "reka-ui";
import { formatChord } from "../lib/shortcut";

defineProps<{
  startAtLogin: boolean;
  /** The Quick window's chord, as stored: the first line names it. */
  quickShortcut: string;
}>();

const emit = defineEmits<{ "update:startAtLogin": [on: boolean]; done: [] }>();

const toggle =
  "relative h-[22px] w-[36px] shrink-0 rounded-full bg-line-strong outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40 data-[state=checked]:bg-brand";
const thumb =
  "block h-[18px] w-[18px] translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[16px]";
</script>

<template>
  <section data-onboarding aria-label="Welcome" class="shrink-0 border-b border-line bg-surface px-4 py-2.5">
    <div class="flex items-start gap-3 rounded-lg border border-brand/30 bg-brand-tint px-3.5 py-3">
      <span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand text-white" aria-hidden="true">
        <svg width="18" height="16" viewBox="152 198 720 628" fill="currentColor" fill-rule="evenodd">
          <mask id="pr-cut-onboarding" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
            <rect width="1024" height="1024" fill="white" />
            <path d="M388 892 Q398 475 636 132" fill="none" stroke="black" stroke-width="88" />
          </mask>
          <path
            d="M184 258 A24 24 0 0 1 208 234 H816 A24 24 0 0 1 840 258 V646 A24 24 0 0 1 816 670 H730 V766 A24 24 0 0 1 706 790 H318 A24 24 0 0 1 294 766 V670 H208 A24 24 0 0 1 184 646 Z M280 330 V574 H390 V694 H634 V574 H744 V330 Z"
            mask="url(#pr-cut-onboarding)"
          />
        </svg>
      </span>
      <div class="min-w-0 flex-1">
        <h2 class="text-[13px] font-semibold text-ink">PortReaper is in your menu bar</h2>
        <ul class="mt-1 space-y-1 text-[12px] leading-snug text-ink-2">
          <li>
            <kbd class="rounded border border-line-strong bg-surface px-1 font-mono text-[11px] text-ink">{{ formatChord(quickShortcut) }}</kbd>
            frees a port from anywhere.
          </li>
          <li>Closing the window leaves PortReaper in the menu bar; Quit lives there.</li>
          <li class="flex items-center gap-2">
            <span id="onboarding-start-at-login">Start at login is {{ startAtLogin ? "on" : "off" }}</span>
            <SwitchRoot
              :model-value="startAtLogin"
              data-pref="startAtLogin"
              aria-labelledby="onboarding-start-at-login"
              :class="toggle"
              @update:model-value="(on: boolean) => emit('update:startAtLogin', on)"
            >
              <SwitchThumb :class="thumb" />
            </SwitchRoot>
          </li>
        </ul>
      </div>
      <button
        type="button"
        data-action="got-it"
        class="mt-0.5 h-7 shrink-0 rounded-md bg-brand px-3 text-[12px] font-semibold text-white outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand/40"
        @click="emit('done')"
      >
        Got it
      </button>
    </div>
  </section>
</template>
