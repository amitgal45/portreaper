<script setup lang="ts">
// The first-run card at the top of the Studio (WP-17b): where the app lives (the menu bar), the
// one shortcut, and the Start at login choice with its toggle, then Got it. App.vue shows it
// while `settings.onboardingDone` is false; Got it stores the flag and the card never comes back.
import { SwitchRoot, SwitchThumb } from "reka-ui";
import { formatChord } from "../lib/shortcut";
import BrandMark from "./BrandMark.vue";

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
      <BrandMark class="mt-0.5 h-7 w-7 shrink-0" />
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
        class="mt-0.5 h-7 shrink-0 rounded-md bg-brand-ink px-3 text-[12px] font-semibold text-surface outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand/40"
        @click="emit('done')"
      >
        Got it
      </button>
    </div>
  </section>
</template>
