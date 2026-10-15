<script setup lang="ts">
// The chord recorder of the Shortcuts rows (WP-17b): a button showing the chord as glyphs (⌘⇧K).
// A click starts recording ("Press keys…"); the next chord with ⌘, ⌃ or ⌥ and a letter or a
// digit is saved; Esc, a second click or leaving cancels. What the recorder will not take (a
// bare letter, ⌘W) is said under it in one line. Reset shows while the chord is not the default.
import { computed, ref } from "vue";
import { chordFromKeyboardEvent, chordProblem, formatChord } from "../lib/shortcut";

const props = defineProps<{
  /** The stored chord, in the plugin's syntax: `CmdOrCtrl+Shift+K`. */
  modelValue: string;
  /** What Reset goes back to. */
  defaultValue: string;
  /** The id of the row's label, for the button's accessible name. */
  labelId: string;
}>();

const emit = defineEmits<{ "update:modelValue": [chord: string] }>();

const recording = ref(false);
/** Why the last chord was refused; cleared by the next key. */
const refused = ref<string | null>(null);
/** The modifiers held right now while recording, as glyphs: feedback before the letter lands. */
const held = ref("");
const button = ref<HTMLButtonElement | null>(null);

const shown = computed(() => formatChord(props.modelValue));
const differs = computed(() => props.modelValue !== props.defaultValue);
const prompt = computed(() => (held.value ? `${held.value}…` : "Press keys…"));

function glyphsHeld(e: KeyboardEvent): string {
  return [e.ctrlKey && "⌃", e.altKey && "⌥", e.metaKey && "⌘", e.shiftKey && "⇧"].filter(Boolean).join("");
}

function toggle() {
  if (recording.value) {
    cancel();
    return;
  }
  recording.value = true;
  refused.value = null;
  held.value = "";
  // WebKit (the app's window) does not focus a button on click: take it, or the keys go to the page.
  button.value?.focus();
}

function cancel() {
  recording.value = false;
  held.value = "";
}

/** While recording every key is ours: the window's shortcuts (digits, Esc, ⌘F) stay quiet. */
function onKeydown(e: KeyboardEvent) {
  if (!recording.value) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    cancel();
    return;
  }
  const chord = chordFromKeyboardEvent(e);
  if (chord === null) {
    held.value = glyphsHeld(e);
    return;
  }
  const problem = chordProblem(chord);
  held.value = "";
  if (problem) {
    refused.value = problem;
    return;
  }
  refused.value = null;
  recording.value = false;
  if (chord !== props.modelValue) emit("update:modelValue", chord);
}

function onKeyup(e: KeyboardEvent) {
  if (!recording.value) return;
  e.preventDefault();
  held.value = glyphsHeld(e);
}

function reset() {
  refused.value = null;
  emit("update:modelValue", props.defaultValue);
}
</script>

<template>
  <div class="flex shrink-0 flex-col items-end gap-1">
    <div class="flex items-center gap-2">
      <button
        v-if="differs && !recording"
        type="button"
        data-action="reset"
        class="rounded px-1 text-[12px] text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
        :title="`Back to ${formatChord(defaultValue)}`"
        @click="reset"
      >
        Reset
      </button>
      <button
        ref="button"
        type="button"
        data-recorder
        :data-recording="recording ? 'true' : undefined"
        :aria-labelledby="labelId"
        :title="recording ? 'Press the new shortcut; Esc keeps the old one' : 'Click, then press the new shortcut'"
        class="flex h-7 min-w-[72px] items-center justify-center rounded-md border px-2.5 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        :class="
          recording
            ? 'border-brand bg-brand-tint font-sans text-brand-ink'
            : 'border-line-strong bg-surface text-ink hover:bg-hover'
        "
        @click="toggle"
        @keydown="onKeydown"
        @keyup="onKeyup"
        @blur="cancel"
      >
        <span v-if="recording">{{ prompt }}</span>
        <kbd v-else>{{ shown }}</kbd>
      </button>
    </div>
    <p v-if="refused" data-refused class="text-[12px] leading-snug text-ink-2">{{ refused }}</p>
  </div>
</template>
