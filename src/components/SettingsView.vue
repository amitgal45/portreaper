<script setup lang="ts">
// The Preferences view (WP-17b), in the main column where the Taskline shows, with its own 52 px
// strip. System Settings' idiom on the Board's tokens: grouped rows on bg-surface cards, 13 px
// labels in text-ink, 12 px help in text-ink-2, toggles, a segmented control for the refresh
// rate and the shortcut recorders. Every control saves at once through `patch`; the row says
// "Saved" for a moment, or in red why the core refused (a shortcut another app owns). Hidden
// ports are chips with a × and a field to add one; the field says in red why it will not take a
// number before anything is sent.
import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "lucide-vue-next";
import { SwitchRoot, SwitchThumb } from "reka-ui";
import { computed, ref } from "vue";
import { isTauri, useApi } from "../api";
import {
  isHideablePort,
  type SettingsPatch,
  withHiddenPort,
  withoutHiddenPort,
} from "../composables/useSettings";
import { formatChord } from "../lib/shortcut";
import { DEFAULT_SETTINGS, MAX_HIDDEN_PORTS, type Settings } from "../types";
import AppMark from "./AppMark.vue";
import ShortcutRecorder from "./ShortcutRecorder.vue";

const props = defineProps<{
  settings: Settings;
  /** Why the last change of a field was refused, by field. */
  error: Partial<Record<keyof Settings, string>>;
  /** Fields that just saved: the row shows "Saved". */
  saved: ReadonlySet<keyof Settings>;
  /** The app's version, for About. */
  version: string;
}>();

const emit = defineEmits<{ patch: [patch: SettingsPatch] }>();

const api = useApi();

const REPOSITORY_URL = "https://github.com/amitgal45/portreaper";
const REFRESH_OPTIONS = [1_000, 2_000, 5_000, 10_000];

interface ToggleRow {
  field: keyof Settings;
  label: string;
  help: (s: Settings) => string;
  on: (s: Settings) => boolean;
  patch: (on: boolean) => SettingsPatch;
}

const GENERAL: ToggleRow[] = [
  {
    field: "dockIcon",
    label: "Show in Dock",
    help: (s) =>
      `Off hides the Dock icon; PortReaper stays in the menu bar and on ${formatChord(s.quickShortcut)}.`,
    on: (s) => s.dockIcon === "show",
    patch: (on) => ({ field: "dockIcon", value: on ? "show" : "hide" }),
  },
  {
    field: "startAtLogin",
    label: "Start at login",
    help: () => "On by default so the menu bar is always there.",
    on: (s) => s.startAtLogin,
    patch: (on) => ({ field: "startAtLogin", value: on }),
  },
];

const KILLING: ToggleRow[] = [
  {
    field: "defaultForce",
    label: "Kill sends SIGKILL at once",
    help: () => "Off: SIGTERM first, SIGKILL after 3 s. ⌥ still flips either way.",
    on: (s) => s.defaultForce,
    patch: (on) => ({ field: "defaultForce", value: on }),
  },
  {
    field: "notifications",
    label: "Notifications",
    help: () => "For kills from the menu bar and for watched ports.",
    on: (s) => s.notifications,
    patch: (on) => ({ field: "notifications", value: on }),
  },
];

const SHORTCUTS: Array<{ field: "quickShortcut" | "windowShortcut"; label: string; help: string }> = [
  { field: "quickShortcut", label: "Free a port…", help: "From anywhere, even with the window closed." },
  { field: "windowShortcut", label: "Open PortReaper", help: "Brings the window to the front." },
];

const checking = ref(false);
/** What the About row says after Check for Updates: nothing inside the app (the core shows a dialog). */
const updateNote = ref<string | null>(null);

async function checkForUpdates() {
  if (checking.value) return;
  checking.value = true;
  updateNote.value = null;
  try {
    await api.checkForUpdates();
    if (!isTauri()) updateNote.value = "Not available in the browser";
  } catch (err) {
    console.error(err);
    updateNote.value = err instanceof Error ? err.message : String(err);
  } finally {
    checking.value = false;
  }
}

/** The repository in the default browser; in a plain tab, a new tab. */
async function openRepository() {
  if (isTauri()) await openUrl(REPOSITORY_URL);
  else window.open(REPOSITORY_URL, "_blank", "noopener");
}

/** The Hidden ports field, as typed. */
const draft = ref("");
/** Why the typed number was not hidden (not a port, or hidden already); cleared by the next key. */
const draftProblem = ref<string | null>(null);
const portInput = ref<HTMLInputElement | null>(null);

/** The core keeps at most `MAX_HIDDEN_PORTS`: nothing more is hidden until one is shown again. */
const hiddenFull = computed(() => props.settings.hiddenPorts.length >= MAX_HIDDEN_PORTS);
const FULL_REASON = `${MAX_HIDDEN_PORTS} is the most: show one again to hide another.`;
const hiddenHelp = computed(() => {
  const chord = formatChord(props.settings.quickShortcut);
  const what = `Left out of the list, the menu bar, ${chord} and the bulk kills. macOS's AirPlay Receiver holds 5000 and 7000.`;
  if (!hiddenFull.value) return what;
  return `${what} ${FULL_REASON}`;
});
/** What the row says in red: the field's own complaint first, else the core's refusal. */
const hiddenProblem = computed(() => draftProblem.value ?? props.error.hiddenPorts ?? null);
const hiddenHintId = "pref-hiddenPorts-hint";
const hiddenErrorId = "pref-hiddenPorts-error";
/** The field is described by the hint, and by the complaint while there is one. */
const hiddenDescribedBy = computed(() => {
  if (!hiddenProblem.value) return hiddenHintId;
  return `${hiddenHintId} ${hiddenErrorId}`;
});

function onDraft(event: Event) {
  draft.value = (event.target as HTMLInputElement).value;
  draftProblem.value = null;
}

/**
 * The field keeps its keys: the list's Enter and ⌘⌫ kill the selection, and its arrows move it;
 * none of them belongs to a number field. Esc (back to the ports) and the window's other ⌘ chords
 * (⌘F, ⌘R, ⌘,) still reach the window.
 */
function keepKeys(event: KeyboardEvent) {
  if (event.key === "Escape") return;
  const chord = event.metaKey || event.ctrlKey;
  if (chord && event.key !== "Backspace" && event.key !== "Enter") return;
  event.stopPropagation();
}

/** Hide and Enter: hides the typed port, or says under the row why not. */
function hideDraft() {
  if (hiddenFull.value) {
    draftProblem.value = FULL_REASON;
    return;
  }
  const port = Number(draft.value.trim());
  if (!isHideablePort(port)) {
    draftProblem.value = "Enter a port from 1 to 65535.";
    return;
  }
  if (props.settings.hiddenPorts.includes(port)) {
    draftProblem.value = `Port ${port} is already hidden.`;
    return;
  }
  draft.value = "";
  draftProblem.value = null;
  emit("patch", { field: "hiddenPorts", value: withHiddenPort(props.settings.hiddenPorts, port) });
}

/**
 * A chip's ×: the port shows again. The focus moves to the field, since its × is gone; a complaint
 * about the full list is out of date.
 */
function showAgain(port: number) {
  draftProblem.value = null;
  emit("patch", { field: "hiddenPorts", value: withoutHiddenPort(props.settings.hiddenPorts, port) });
  portInput.value?.focus();
}

const labelId = (field: keyof Settings) => `pref-${field}`;

const heading = "px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3";
const card = "divide-y divide-line rounded-lg border border-line bg-surface";
const row = "flex items-start gap-4 px-3.5 py-2.5";
const label = "text-[13px] text-ink";
const help = "mt-0.5 text-[12px] leading-snug text-ink-2";
const savedMark = "text-[12px] text-ink-3 transition-opacity duration-300";
const errorLine = "mt-0.5 text-[12px] leading-snug text-red-ink";
const toggle =
  "relative mt-0.5 h-[22px] w-[36px] shrink-0 rounded-full bg-line-strong outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40 data-[state=checked]:bg-brand";
const thumb =
  "block h-[18px] w-[18px] translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[16px]";
const button =
  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong bg-surface px-2.5 text-[12px] font-medium text-ink outline-none enabled:hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60";
const portField =
  "h-7 w-[88px] rounded-md border border-line bg-canvas px-2 font-mono text-[12px] text-ink tabular-nums outline-none placeholder:font-sans placeholder:text-ink-3 focus:border-line-strong focus:ring-2 focus:ring-brand/20";
const chip =
  "inline-flex h-[22px] items-center gap-0.5 whitespace-nowrap rounded-full border border-line bg-canvas pr-0.5 pl-2 font-mono text-[12px] text-ink-2 tabular-nums";
// The × is a 24 px target (WCAG 2.5.8) around the 18 px circle the chip shows; the negative margin
// keeps the chip as wide as the circle alone made it.
const chipRemove =
  "group -mx-[3px] flex h-6 w-6 shrink-0 items-center justify-center rounded-full outline-none";
const chipRemoveMark =
  "flex h-[18px] w-[18px] items-center justify-center rounded-full text-ink-3 group-hover:bg-hover group-hover:text-ink group-focus-visible:ring-2 group-focus-visible:ring-brand/40";
</script>

<template>
  <section data-view="settings" aria-label="Preferences" class="flex min-h-0 flex-1 flex-col">
    <header
      data-tauri-drag-region
      class="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line bg-surface px-4"
    >
      <h1 class="text-[13px] font-semibold text-ink">Preferences</h1>
      <span data-tauri-drag-region class="min-w-0 flex-1" />
      <span
        class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-1.5 py-1 font-mono text-[11px] text-ink-3"
        title="Esc goes back to the ports"
      >
        <kbd>esc</kbd>
        <span class="font-sans">Back to ports</span>
      </span>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto bg-canvas p-4">
      <div class="mx-auto flex w-full max-w-[600px] flex-col gap-5">
        <section aria-labelledby="pref-group-general">
          <h2 id="pref-group-general" :class="heading">General</h2>
          <div :class="card">
            <div v-for="it in GENERAL" :key="it.field" :class="row" :data-row="it.field">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span :id="labelId(it.field)" :class="label">{{ it.label }}</span>
                  <span :class="[savedMark, saved.has(it.field) ? 'opacity-100' : 'opacity-0']" aria-hidden="true">Saved</span>
                </div>
                <p :class="help">{{ it.help(settings) }}</p>
                <p v-if="error[it.field]" :class="errorLine" role="alert">{{ error[it.field] }}</p>
              </div>
              <SwitchRoot
                :model-value="it.on(settings)"
                :data-pref="it.field"
                :aria-labelledby="labelId(it.field)"
                :class="toggle"
                @update:model-value="(on: boolean) => emit('patch', it.patch(on))"
              >
                <SwitchThumb :class="thumb" />
              </SwitchRoot>
            </div>

            <div :class="row" data-row="refreshMs">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span :id="labelId('refreshMs')" :class="label">Refresh every</span>
                  <span :class="[savedMark, saved.has('refreshMs') ? 'opacity-100' : 'opacity-0']" aria-hidden="true">Saved</span>
                </div>
                <p :class="help">How often the list and the menu bar re-read the ports.</p>
                <p v-if="error.refreshMs" :class="errorLine" role="alert">{{ error.refreshMs }}</p>
              </div>
              <div
                role="radiogroup"
                data-pref="refreshMs"
                :aria-labelledby="labelId('refreshMs')"
                class="flex h-7 shrink-0 items-center rounded-md border border-line bg-canvas p-0.5"
              >
                <button
                  v-for="ms in REFRESH_OPTIONS"
                  :key="ms"
                  type="button"
                  role="radio"
                  :aria-checked="settings.refreshMs === ms"
                  :data-value="ms"
                  class="h-full rounded-[5px] px-2.5 text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  :class="settings.refreshMs === ms ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-2 hover:text-ink'"
                  @click="emit('patch', { field: 'refreshMs', value: ms })"
                >
                  {{ ms / 1000 }} s
                </button>
              </div>
            </div>

            <div :class="row" data-row="hiddenPorts">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span :id="labelId('hiddenPorts')" :class="label">Hidden ports</span>
                  <span :class="[savedMark, saved.has('hiddenPorts') ? 'opacity-100' : 'opacity-0']" aria-hidden="true">Saved</span>
                </div>
                <p :id="hiddenHintId" :class="help">{{ hiddenHelp }}</p>
                <ul
                  v-if="settings.hiddenPorts.length > 0"
                  data-hidden-ports
                  :aria-labelledby="labelId('hiddenPorts')"
                  class="mt-2 flex flex-wrap gap-1.5"
                >
                  <li v-for="port in settings.hiddenPorts" :key="port" :data-hidden-port="port" :class="chip">
                    :{{ port }}
                    <button
                      type="button"
                      :aria-label="`Show port ${port} again`"
                      :title="`Show port ${port} again`"
                      :class="chipRemove"
                      @click="showAgain(port)"
                    >
                      <span :class="chipRemoveMark"><X :size="12" :stroke-width="2" aria-hidden="true" /></span>
                    </button>
                  </li>
                </ul>
                <p v-if="hiddenProblem" :id="hiddenErrorId" :class="errorLine" role="alert">{{ hiddenProblem }}</p>
              </div>
              <!-- Every key but Esc stays in the field (keepKeys): the list's Enter and ⌘⌫ never see it. -->
              <div data-pref="hiddenPorts" class="flex shrink-0 items-center gap-2">
                <input
                  ref="portInput"
                  type="number"
                  min="1"
                  max="65535"
                  step="1"
                  autocomplete="off"
                  placeholder="Port"
                  aria-label="Port to hide"
                  :aria-invalid="draftProblem && draftProblem !== FULL_REASON ? 'true' : undefined"
                  :aria-describedby="hiddenDescribedBy"
                  :value="draft"
                  :class="portField"
                  @input="onDraft"
                  @keydown.enter.prevent="hideDraft"
                  @keydown="keepKeys"
                />
                <!-- Dimmed but still pressable at the limit: it says why under the row. -->
                <button
                  type="button"
                  data-action="hide-port"
                  :class="[button, hiddenFull && 'opacity-60']"
                  :aria-disabled="hiddenFull ? 'true' : undefined"
                  @click="hideDraft"
                >
                  Hide
                </button>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="pref-group-shortcuts">
          <h2 id="pref-group-shortcuts" :class="heading">Shortcuts</h2>
          <div :class="card">
            <div v-for="it in SHORTCUTS" :key="it.field" :class="row" :data-row="it.field">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span :id="labelId(it.field)" :class="label">{{ it.label }}</span>
                  <span :class="[savedMark, saved.has(it.field) ? 'opacity-100' : 'opacity-0']" aria-hidden="true">Saved</span>
                </div>
                <p :class="help">{{ it.help }}</p>
                <p v-if="error[it.field]" :class="errorLine" role="alert">{{ error[it.field] }}</p>
              </div>
              <ShortcutRecorder
                :data-pref="it.field"
                :model-value="settings[it.field]"
                :default-value="DEFAULT_SETTINGS[it.field]"
                :label-id="labelId(it.field)"
                @update:model-value="(chord: string) => emit('patch', { field: it.field, value: chord })"
              />
            </div>
          </div>
        </section>

        <section aria-labelledby="pref-group-killing">
          <h2 id="pref-group-killing" :class="heading">Killing</h2>
          <div :class="card">
            <div v-for="it in KILLING" :key="it.field" :class="row" :data-row="it.field">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span :id="labelId(it.field)" :class="label">{{ it.label }}</span>
                  <span :class="[savedMark, saved.has(it.field) ? 'opacity-100' : 'opacity-0']" aria-hidden="true">Saved</span>
                </div>
                <p :class="help">{{ it.help(settings) }}</p>
                <p v-if="error[it.field]" :class="errorLine" role="alert">{{ error[it.field] }}</p>
              </div>
              <SwitchRoot
                :model-value="it.on(settings)"
                :data-pref="it.field"
                :aria-labelledby="labelId(it.field)"
                :class="toggle"
                @update:model-value="(on: boolean) => emit('patch', it.patch(on))"
              >
                <SwitchThumb :class="thumb" />
              </SwitchRoot>
            </div>
          </div>
        </section>

        <section aria-labelledby="pref-group-about">
          <h2 id="pref-group-about" :class="heading">About</h2>
          <div :class="card">
            <div :class="row" data-row="about">
              <AppMark class="mt-0.5 h-7 w-7 shrink-0" />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-baseline gap-x-2">
                  <span data-version class="text-[13px] font-semibold text-ink">PortReaper {{ version || "…" }}</span>
                  <span class="text-[12px] text-ink-2">Kill ports. See what is behind them.</span>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" data-action="check-updates" :class="button" :disabled="checking" @click="checkForUpdates">
                    {{ checking ? "Checking…" : "Check for Updates…" }}
                  </button>
                  <button type="button" data-action="repository" :class="button" @click="openRepository">Repository ↗</button>
                  <span v-if="updateNote" data-update-note class="text-[12px] text-ink-2">{{ updateNote }}</span>
                </div>
                <p :class="help">MIT License · github.com/amitgal45/portreaper</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
