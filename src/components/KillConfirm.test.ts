import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_ENTRIES } from "../api/mock";
import { ACTIONS_KEY, type UiActions } from "../composables/useActions";
import type { KillTarget } from "../composables/useKillFlow";
import { groupEntries } from "../composables/usePorts";
import { protectionReason } from "../lib/protection";
import type { LaunchdJob, PortEntry } from "../types";
import KillConfirm from "./KillConfirm.vue";

const byPort = (port: number): PortEntry => {
  const e = MOCK_ENTRIES.find((x) => x.port === port);
  if (!e) throw new Error(`no mock entry on ${port}`);
  return e;
};

function spies(): UiActions {
  return {
    select: vi.fn(),
    inspect: vi.fn(),
    kill: vi.fn(),
    killGroup: vi.fn(),
    restart: vi.fn(),
    reap: vi.fn(),
    toggleGroup: vi.fn(),
    openInBrowser: vi.fn(),
    copyKill: vi.fn(),
    copyCommand: vi.fn(),
    copyStopCommand: vi.fn(),
    revealFolder: vi.fn(),
    watch: vi.fn(),
    hide: vi.fn(),
  };
}

let mounted: VueWrapper | null = null;

/** The dialog on `target`, the way App.vue feeds it: the reasons, and the ports from `entries` (the mock's). */
async function mountConfirm(target: KillTarget, actions = spies(), entries: PortEntry[] = MOCK_ENTRIES) {
  const wrapper = mount(KillConfirm, {
    props: {
      target,
      reasonFor: (e: PortEntry) => protectionReason(e, "amit"),
      portsOf: (pid: number) => entries.filter((e) => e.pid === pid && e.port > 0).map((e) => e.port),
    },
    global: { provide: { [ACTIONS_KEY as symbol]: actions } },
    attachTo: document.body,
  });
  mounted = wrapper;
  await flushPromises();
  return { wrapper, actions };
}

/** The dialog is portalled to the body. */
const dialog = () => document.body.querySelector<HTMLElement>("[role='alertdialog']");
const text = () => dialog()?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const buttons = () => [...(dialog()?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim());
const button = (name: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === name) ?? null;

/** Unmounts the dialog and drops its portal, so the next mount is the only dialog on the page. */
function reset() {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
}

const ollama = byPort(11434);
const job = ollama.launchd as LaunchdJob;

const CONTROL_CENTER_EXE = "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter";

/** ControlCenter on :5000 (AirPlay Receiver) as the core sends it: Apple's job, a system one. */
const controlCenter: PortEntry = {
  ...byPort(7000),
  port: 5000,
  pid: 635,
  processName: "ControlCenter",
  command: CONTROL_CENTER_EXE,
  exe: CONTROL_CENTER_EXE,
  parentPid: 1,
  protected: true,
  launchd: { label: "com.apple.controlcenter", restarts: null, brew: null, stopCommand: null, system: true },
};
/** The mock machine with ControlCenter on :5000 instead of :7000: pid 635 holds that one port. */
const withControlCenter = MOCK_ENTRIES.map((e) => (e.port === 7000 ? controlCenter : e));

describe("KillConfirm", () => {
  afterEach(reset);

  it("says launchd brings a restarting job back, names the command that stops it, and offers to copy it", async () => {
    const { wrapper, actions } = await mountConfirm({ kind: "entry", entry: ollama, force: false });
    expect(text()).toContain("Kill ollama (32014)?");
    const sentences = [
      "ollama is a Homebrew service (ollama) that launchd starts again after a kill.",
      "It holds port 11434.",
      "To stop it for good, run brew services stop ollama.",
      "This sends SIGTERM and waits up to 3 s before SIGKILL.",
    ];
    expect(text()).toContain(sentences.join(" "));
    // The reason says it comes back; nothing says it twice.
    expect(text().match(/starts (it )?again/g)).toHaveLength(1);
    // Copy command is the secondary verb, left of Cancel.
    expect(buttons()).toEqual(["Copy command", "Cancel", "Kill anyway"]);

    button("Copy command")?.click();
    await flushPromises();
    expect(actions.copyStopCommand).toHaveBeenCalledWith(ollama);
    expect(actions.copyCommand).not.toHaveBeenCalled();
    // Copying decides nothing: the dialog stays, nothing was confirmed or cancelled.
    expect(wrapper.emitted("cancel")).toBeUndefined();
    expect(wrapper.emitted("confirm")).toBeUndefined();
    expect(dialog()).not.toBeNull();
    expect(text()).toContain("Kill ollama (32014)?");

    // Kill anyway still confirms.
    button("Kill anyway")?.click();
    expect(wrapper.emitted("confirm")).toHaveLength(1);
  });

  it("without a command the core would put in a shell: the reason still says it restarts, and no Copy command", async () => {
    const entry = { ...ollama, launchd: { ...job, stopCommand: null } };
    await mountConfirm({ kind: "entry", entry, force: true });
    expect(text()).toContain(
      "ollama is a Homebrew service (ollama) that launchd starts again after a kill. It holds port 11434. This sends SIGKILL at once.",
    );
    expect(text()).not.toContain("To stop it for good");
    expect(buttons()).toEqual(["Cancel", "Kill anyway"]);
  });

  it("a job nobody can tell about says launchd may start it again, and still offers the command", async () => {
    const entry = { ...ollama, launchd: { ...job, restarts: null } };
    const { actions } = await mountConfirm({ kind: "entry", entry, force: false });
    expect(text()).toContain(
      [
        "ollama is a Homebrew service (ollama) that launchd may start again after a kill.",
        "It holds port 11434.",
        "To stop it for good, run brew services stop ollama.",
        "This sends SIGTERM and waits up to 3 s before SIGKILL.",
      ].join(" "),
    );
    expect(buttons()).toEqual(["Copy command", "Cancel", "Kill anyway"]);
    button("Copy command")?.click();
    await flushPromises();
    expect(actions.copyStopCommand).toHaveBeenCalledWith(entry);
  });

  it("ControlCenter on :5000, Apple's job: a system process that asks, with no launchd sentence and nothing to copy", async () => {
    const { wrapper } = await mountConfirm(
      { kind: "entry", entry: controlCenter, force: false },
      spies(),
      withControlCenter,
    );
    expect(text()).toContain("Kill ControlCenter (635)?");
    expect(text()).toContain(
      [
        "ControlCenter is a system process.",
        "It holds port 5000.",
        "This sends SIGTERM and waits up to 3 s before SIGKILL.",
      ].join(" "),
    );
    expect(text()).not.toContain("To stop it for good");
    expect(text()).not.toContain("launchctl");
    expect(text()).not.toContain("launchd");
    // It asks: Kill anyway is the second step, and nothing to copy sits beside it.
    expect(buttons()).toEqual(["Cancel", "Kill anyway"]);
    button("Kill anyway")?.click();
    expect(wrapper.emitted("confirm")).toHaveLength(1);
    reset();

    // Whatever launchd does to it, and even with a command a buggy core sent: still a system process.
    const apple = controlCenter.launchd as LaunchdJob;
    const stopCommand =
      "launchctl disable gui/501/com.apple.controlcenter && launchctl bootout gui/501/com.apple.controlcenter";
    for (const launchd of [
      { ...apple, restarts: true },
      { ...apple, restarts: true, stopCommand },
    ]) {
      await mountConfirm(
        { kind: "entry", entry: { ...controlCenter, launchd }, force: false },
        spies(),
        withControlCenter,
      );
      expect(text()).toContain("ControlCenter is a system process. It holds port 5000.");
      expect(text()).not.toContain("launchctl");
      expect(buttons()).toEqual(["Cancel", "Kill anyway"]);
      reset();
    }
  });

  it("says nothing of launchd for a job that stays down, Docker, a group, or an entry without the field", async () => {
    const stays = { ...ollama, launchd: { ...job, restarts: false } };
    await mountConfirm({ kind: "entry", entry: stays, force: false });
    expect(text()).toContain("ollama is a protected process.");
    expect(text()).not.toContain("starts again");
    expect(text()).not.toContain("To stop it for good");
    expect(buttons()).toEqual(["Cancel", "Kill anyway"]);
    reset();

    await mountConfirm({ kind: "entry", entry: byPort(5432), force: false });
    expect(text()).toContain("com.docker.backend is Docker.");
    expect(buttons()).toEqual(["Cancel", "Kill anyway"]);
    reset();

    // A group names the reason per process; the copy is the single row's (its dialog or the inspector).
    const group = groupEntries([ollama])[0];
    if (!group) throw new Error("no group");
    await mountConfirm({ kind: "group", group, force: false });
    const reason = "ollama is a Homebrew service (ollama) that launchd starts again after a kill.";
    expect(text()).toContain(`1 process: ollama (32014). ${reason}`);
    expect(buttons()).toEqual(["Cancel", "Kill anyway"]);
    reset();

    // The Quick strip's cache can hold entries from before the core sent `launchd`.
    const older = { ...ollama, launchd: undefined } as unknown as PortEntry;
    await mountConfirm({ kind: "entry", entry: older, force: false });
    expect(text()).toContain("ollama is a protected process.");
    expect(buttons()).toEqual(["Cancel", "Kill anyway"]);
  });
});
