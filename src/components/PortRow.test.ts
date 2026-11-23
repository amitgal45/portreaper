import { flushPromises, mount } from "@vue/test-utils";
import { TooltipProvider } from "reka-ui";
import { describe, expect, it, vi } from "vitest";
import { type Component, defineComponent, h } from "vue";
import { createMockApi, MOCK_ENTRIES } from "../api/mock";
import { ACTIONS_KEY, type UiActions } from "../composables/useActions";
import { useKillFlow } from "../composables/useKillFlow";
import { usePorts } from "../composables/usePorts";
import { useToasts } from "../composables/useToasts";
import { WATCHED_KEY } from "../composables/useWatch";
import type { LaunchdJob, PortEntry } from "../types";
import HintTooltip from "./HintTooltip.vue";
import { DotIcon, GlobeIcon, type IconProps, SparkIcon, ZapIcon } from "./icons";
import PortRow from "./PortRow.vue";

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

function mountRow(
  entry: PortEntry,
  actions: UiActions,
  extra: Partial<InstanceType<typeof PortRow>["$props"]> = {},
  provide: Record<symbol, unknown> = {},
) {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(TooltipProvider, null, {
        default: () =>
          h(PortRow, {
            entry,
            selected: false,
            pending: false,
            reason: entry.protected ? "Docker" : null,
            collision: false,
            ...extra,
          }),
      }),
  });
  return mount(Wrapper, {
    global: { provide: { [ACTIONS_KEY as symbol]: actions, ...provide } },
    attachTo: document.body,
  });
}

/** The status pills of a row, in order. */
const pillsOf = (wrapper: ReturnType<typeof mountRow>) =>
  wrapper.findAll("[data-badge]").map((b) => [b.attributes("data-badge"), b.text()]);

/** The hints of the pills that have one, in order (a tooltip's text is only in the DOM while it is open). */
const hintsOf = (wrapper: ReturnType<typeof mountRow>) =>
  wrapper.findAllComponents(HintTooltip).map((t) => t.props("text"));

/** The five statuses, the icon each draws and its ink (spec item 8; decisions: Protected dot, AI spark). */
const STATUSES: [port: number, badge: string, icon: Component, ink: string][] = [
  [3000, "running", DotIcon, "text-green-ink"],
  [5174, "zombie", ZapIcon, "text-orange-ink"],
  [8080, "public", GlobeIcon, "text-red-ink"],
  [53, "protected", DotIcon, "text-blue-ink"],
  [11434, "ai", SparkIcon, "text-purple-ink"],
];

/** Every element of a row, the row included. */
const everything = (wrapper: ReturnType<typeof mountRow>) => {
  const row = wrapper.get("[role='row']").element;
  return [row, ...row.querySelectorAll<Element>("*")];
};
/** An element's classes as the DOM has them (an SVG's `className` is not a string). */
const classesOf = (el: Element) => [...el.classList];

describe("PortRow", () => {
  it("kills an unprotected row on click, and forces on ⌥-click", async () => {
    const actions = spies();
    const wrapper = mountRow(byPort(3000), actions);
    const kill = wrapper.get("button[aria-label='Kill']");
    await kill.trigger("click");
    expect(actions.kill).toHaveBeenLastCalledWith(byPort(3000), false);
    await kill.trigger("click", { altKey: true });
    expect(actions.kill).toHaveBeenLastCalledWith(byPort(3000), true);
    expect(actions.inspect).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("opens the inspector on a plain click of the row; the row menu's trigger does not", async () => {
    const actions = spies();
    const wrapper = mountRow(byPort(3000), actions);
    await wrapper.get("[role='row']").trigger("click");
    expect(actions.inspect).toHaveBeenCalledWith(byPort(3000));
    await wrapper.get("button[aria-label='More']").trigger("click");
    expect(actions.inspect).toHaveBeenCalledTimes(1);
    expect(actions.kill).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("opens the confirm instead of killing a protected row", async () => {
    const api = createMockApi();
    const killProcess = vi.spyOn(api, "killProcess");
    const ports = usePorts(api, { storage: null });
    await ports.refresh();
    const flow = useKillFlow(ports, useToasts());
    const actions: UiActions = {
      ...spies(),
      kill: (entry, force) => void flow.request({ kind: "entry", entry, force }),
    };

    const wrapper = mountRow(byPort(5432), actions);
    await wrapper.get("button[aria-label='Kill']").trigger("click");
    expect(killProcess).not.toHaveBeenCalled();
    expect(flow.confirm.value).toMatchObject({ kind: "entry", force: false });
    expect(flow.confirm.value?.kind === "entry" && flow.confirm.value.entry.pid).toBe(11710);
    wrapper.unmount();
  });

  it("shows one pill per state, worst first, and Running when nothing applies", () => {
    const actions = spies();
    const running = mountRow(byPort(3000), actions);
    expect(pillsOf(running)).toEqual([["running", "Running"]]);
    expect(running.text()).toContain("3000");
    expect(running.text()).toContain("412 MB");
    expect(running.text()).toContain("2 h");
    running.unmount();

    const zombie = mountRow(byPort(5174), actions);
    expect(pillsOf(zombie)).toEqual([["zombie", "Zombie"]]);
    zombie.unmount();

    const exposed = mountRow(byPort(8080), actions);
    expect(pillsOf(exposed)).toEqual([["public", "Public"]]);
    exposed.unmount();

    // Docker, bound to every interface: both, the alarm first.
    const docker = mountRow(byPort(5432), actions);
    expect(pillsOf(docker)).toEqual([
      ["public", "Public"],
      ["protected", "Protected"],
    ]);
    expect(docker.get("[role='row']").attributes("data-category")).toBe("db");
    docker.unmount();

    // A system daemon on every interface is not "public" (the filter agrees): protected only.
    const mdns = mountRow(byPort(53), actions);
    expect(pillsOf(mdns)).toEqual([["protected", "Protected"]]);
    expect(mdns.text()).toContain("udp");
    mdns.unmount();

    // Ollama as a brew service launchd restarts after a kill: protected, still a model server, and
    // the neutral launchd chip last.
    const ai = mountRow(byPort(11434), actions);
    expect(pillsOf(ai)).toEqual([
      ["protected", "Protected"],
      ["ai", "AI · 4.9 GB"],
      ["launchd", "launchd"],
    ]);
    ai.unmount();

    // An orphan that is protected shows both: its terminal is gone, and Reap will leave it alone.
    const guarded = mountRow({ ...byPort(4000), protected: true }, actions);
    expect(pillsOf(guarded)).toEqual([
      ["zombie", "Zombie"],
      ["protected", "Protected"],
    ]);
    guarded.unmount();
  });

  it("a launchd job gets the neutral launchd chip with who runs it and what a kill does, never Zombie", () => {
    const actions = spies();
    const job = byPort(11434).launchd as LaunchdJob;
    const ollama = mountRow(byPort(11434), actions, {
      reason: "a Homebrew service (ollama) that launchd starts again after a kill",
    });
    const chip = ollama.get("[data-badge='launchd']");
    expect(chip.text()).toBe("launchd");
    expect(chip.classes()).toEqual(expect.arrayContaining(["border-line", "bg-canvas", "text-ink-2"]));
    expect(ollama.find("[data-badge='zombie']").exists()).toBe(false);
    expect(hintsOf(ollama)).toEqual([
      "a Homebrew service (ollama) that launchd starts again after a kill — asks before killing",
      "a local model server; this is the memory it holds",
      "started by launchd (homebrew.mxcl.ollama): a kill is undone within seconds",
    ]);
    ollama.unmount();

    // A LaunchAgent that stays down after a kill: not protected, so Running first, then the chip.
    const agent = {
      ...byPort(9335),
      parentPid: 1,
      launchd: { ...job, label: "com.example.agent", restarts: false },
    };
    const stays = mountRow(agent, actions);
    expect(pillsOf(stays)).toEqual([
      ["running", "Running"],
      ["launchd", "launchd"],
    ]);
    expect(hintsOf(stays)).toEqual([
      "started by launchd (com.example.agent): a kill lasts until the next login",
    ]);
    stays.unmount();

    const vague = mountRow({ ...agent, launchd: { ...agent.launchd, restarts: null } }, actions);
    expect(hintsOf(vague)).toEqual(["started by launchd (com.example.agent): launchd may start it again"]);
    vague.unmount();

    // An entry from a core that did not send `launchd` yet (the Quick strip's cache): no chip, no error.
    const older = { ...byPort(3000), launchd: undefined } as unknown as PortEntry;
    const plain = mountRow(older, actions);
    expect(pillsOf(plain)).toEqual([["running", "Running"]]);
    plain.unmount();
  });

  it("ControlCenter on :5000, a system job: Protected, and the launchd chip calls it a system process too", () => {
    const exe = "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter";
    const controlCenter: PortEntry = {
      ...byPort(7000),
      port: 5000,
      pid: 635,
      processName: "ControlCenter",
      command: exe,
      exe,
      parentPid: 1,
      protected: true,
      launchd: {
        label: "com.apple.controlcenter",
        restarts: true,
        brew: null,
        stopCommand: null,
        system: true,
      },
    };
    const row = mountRow(controlCenter, spies(), { reason: "a system process" });
    expect(row.find("[data-badge='zombie']").exists()).toBe(false);
    const hints = hintsOf(row);
    expect(hints).toContain("a system process — asks before killing");
    expect(hints).toContain("started by launchd (com.apple.controlcenter): a system process");
    expect(hints.join(" ")).not.toContain("undone within seconds");
    row.unmount();
  });

  it("draws the brand mark for a known stack, a text pill for an unknown one, nothing otherwise", () => {
    const actions = spies();
    const next = mountRow(byPort(3000), actions);
    expect(next.get("[data-testid='framework-icon']").attributes("data-brand")).toBe("Next.js");
    expect(next.get("[data-testid='framework-icon']").attributes("title")).toBe("Next.js");
    expect(next.find("[data-badge='framework']").exists()).toBe(false);
    next.unmount();

    // The framework names the stack; the process name alone would say Docker.
    const postgres = mountRow(byPort(5432), actions);
    expect(postgres.get("[data-testid='framework-icon']").attributes("data-brand")).toBe("PostgreSQL");
    postgres.unmount();

    const airplay = mountRow({ ...byPort(7000), framework: "AirPlay" }, actions);
    expect(airplay.find("[data-testid='framework-icon']").exists()).toBe(false);
    expect(airplay.get("[data-badge='framework']").text()).toBe("AirPlay");
    airplay.unmount();

    // "mDNSResponder" on an mDNSResponder row would repeat the name: nothing.
    const mdns = mountRow(byPort(53), actions);
    expect(mdns.find("[data-testid='framework-icon']").exists()).toBe(false);
    expect(mdns.find("[data-badge='framework']").exists()).toBe(false);
    expect(mdns.text().match(/mDNSResponder/g)).toHaveLength(1);
    mdns.unmount();

    const helper = mountRow(byPort(9335), actions);
    expect(helper.find("[data-testid='framework-icon']").exists()).toBe(false);
    expect(helper.find("[data-badge='framework']").exists()).toBe(false);
    helper.unmount();
  });

  it("keeps the command line out of the row: it lives in the inspector", () => {
    const wrapper = mountRow(byPort(3000), spies());
    expect(wrapper.text()).not.toContain("next dev");
    expect(wrapper.text()).not.toContain("feature/cart");
    wrapper.unmount();
  });

  it("turns the port orange after a collision", () => {
    const quiet = mountRow(byPort(3000), spies());
    expect(quiet.get("[role='row'] > span").classes()).toContain("text-ink");
    quiet.unmount();
    const hot = mountRow(byPort(3000), spies(), { collision: true });
    expect(hot.get("[role='row'] > span").classes()).toContain("text-orange-ink");
    hot.unmount();
  });

  it("is a 34 px row on the row line, the hover fill when it is not selected (B v3, spec item 4)", () => {
    const plain = mountRow(byPort(3000), spies());
    const row = plain.get("[role='row']");
    expect(row.classes()).toEqual(expect.arrayContaining(["h-[34px]", "border-row-line", "hover:bg-hover"]));
    expect(row.classes()).not.toContain("h-10");
    expect(row.classes()).not.toContain("border-line");
    plain.unmount();
  });

  it("draws each status as coloured text with its icon, never a filled pill (spec item 8)", () => {
    for (const [port, key, icon, ink] of STATUSES) {
      const row = mountRow(byPort(port), spies());
      const badge = row.get(`[data-badge='${key}']`);
      expect(badge.classes(), key).toEqual(
        expect.arrayContaining([ink, "text-[12px]", "font-medium", "gap-[5px]"]),
      );
      // No pill: no fill, no radius, no padding, no fixed height, no border.
      expect(
        badge.classes().filter((c) => /^(bg-|rounded|px-|h-|border)/.test(c)),
        `${key} is a pill`,
      ).toEqual([]);
      // Its icon first, 13 px, inside the badge.
      const drawn = row.findAllComponents(icon).filter((c) => badge.element.contains(c.element));
      expect(drawn, `${key} icon`).toHaveLength(1);
      expect((drawn[0]?.props() as IconProps | undefined)?.size, `${key} icon size`).toBe(13);
      expect(badge.element.firstElementChild?.tagName.toLowerCase(), `${key} icon first`).toBe("svg");
      row.unmount();
    }

    // Two statuses on one row, each with its own icon: Public's globe, then Protected's dot.
    const docker = mountRow(byPort(5432), spies());
    const globe = docker.findAllComponents(GlobeIcon).map((c) => c.element.closest("[data-badge]"));
    const dot = docker.findAllComponents(DotIcon).map((c) => c.element.closest("[data-badge]"));
    expect(globe.map((b) => b?.getAttribute("data-badge"))).toEqual(["public"]);
    expect(dot.map((b) => b?.getAttribute("data-badge"))).toEqual(["protected"]);
    // The first shows at every width; the next only from 640 px of main column. The second has no
    // `inline-flex` of its own: Tailwind writes `.hidden` before `.inline-flex`, so it would win.
    const first = docker.get("[data-badge='public']").classes();
    const second = docker.get("[data-badge='protected']").classes();
    expect(first).toContain("inline-flex");
    expect(first).not.toContain("hidden");
    expect(second).toEqual(expect.arrayContaining(["hidden", "@min-[640px]/main:inline-flex"]));
    expect(second).not.toContain("inline-flex");
    docker.unmount();

    // The launchd chip is who runs it, not a status: no icon, still the soft bordered chip.
    const ollama = mountRow(byPort(11434), spies());
    const chip = ollama.get("[data-badge='launchd']");
    expect(chip.find("svg").exists()).toBe(false);
    expect(chip.classes()).toEqual(
      expect.arrayContaining(["rounded-full", "border", "border-line", "bg-canvas"]),
    );
    ollama.unmount();
  });

  it("the selected row is the coral fill, and every text and icon in it is white at full opacity", () => {
    const isWatched = (t: { port: number; protocol: string }) => t.port === 7000;
    const container = MOCK_ENTRIES.find((e) => e.container);
    if (!container) throw new Error("no container in the mock");
    const cases: [what: string, entry: PortEntry, extra?: { collision: boolean }][] = [
      ["a dev server after a collision", byPort(3000), { collision: true }],
      ["a udp daemon", byPort(53)],
      ["a launchd job with three statuses", byPort(11434)],
      ["an unknown stack, watched", { ...byPort(7000), framework: "AirPlay" }],
      ["a container", container],
      ["a stdio orphan", { ...byPort(5174), port: 0, pid: 61204, address: "stdio" }],
    ];
    for (const [what, entry, extra] of cases) {
      const wrapper = mountRow(
        entry,
        spies(),
        { selected: true, ...extra },
        { [WATCHED_KEY as symbol]: isWatched },
      );
      const row = wrapper.get("[role='row']");
      expect(row.attributes("aria-selected")).toBe("true");
      expect(row.classes(), what).toEqual(expect.arrayContaining(["bg-sel-fill", "text-on-sel-fill"]));
      // No tint, no left bar, no hover fill on the coral.
      expect(
        row.classes().filter((c) => c === "bg-sel" || c.startsWith("before:") || c.startsWith("hover:")),
      ).toEqual([]);
      const kill = wrapper.get("button[aria-label='Kill']").element;
      for (const el of everything(wrapper)) {
        const classes = classesOf(el);
        // No grey and no ink of a status anywhere; Kill alone is the surface with red ink.
        expect(
          classes.filter((c) => /^text-ink(-\d)?$/.test(c)),
          `${what}: ${el.tagName} ${classes.join(" ")}`,
        ).toEqual([]);
        if (el !== kill) {
          expect(
            classes.filter((c) => /^text-(green|orange|red|blue|purple|brand)(-ink)?$/.test(c)),
            `${what}: ${el.tagName} ${classes.join(" ")}`,
          ).toEqual([]);
        }
        // Full opacity: no opacity utility (Kill's opacity-100 aside) and no alpha on a text colour.
        expect(
          classes.filter(
            (c) => (/^opacity-/.test(c) && !(el === kill && c === "opacity-100")) || /^text-.+\/\d+$/.test(c),
          ),
          `${what}: ${el.tagName} ${classes.join(" ")}`,
        ).toEqual([]);
      }
      // Each status, chip and mark says white itself, so nothing inherits a colour from elsewhere.
      for (const badge of row.findAll("[data-badge]")) {
        expect(badge.classes(), `${what}: ${badge.attributes("data-badge")}`).toContain("text-on-sel-fill");
      }
      wrapper.unmount();
    }
  });

  it("on the selected row the pid, memory, uptime, udp tag and port are white; the chips are white on the coral", () => {
    const wrapper = mountRow(byPort(53), spies(), { selected: true });
    for (const text of ["4102", "udp"]) {
      const el = wrapper.findAll("span").find((s) => s.text() === text);
      expect(el?.classes(), text).toContain("text-on-sel-fill");
    }
    expect(wrapper.get("[role='row'] > span").classes()).toContain("text-on-sel-fill");
    wrapper.unmount();

    const ollama = mountRow(byPort(11434), spies(), { selected: true });
    // The cells: port · process · status · memory · uptime · actions.
    const cells = ollama.findAll("[role='row'] > span");
    expect(cells[3]?.text()).toBe("4.9 GB");
    for (const cell of [cells[3], cells[4]]) {
      expect(cell?.classes(), cell?.text()).toContain("text-on-sel-fill");
    }
    // The launchd chip: white text, no fill of its own (white 18% over the coral would be 3.7:1), a white edge.
    const chip = ollama.get("[data-badge='launchd']");
    expect(chip.classes()).toEqual(
      expect.arrayContaining(["border", "border-on-sel-fill/60", "text-on-sel-fill"]),
    );
    expect(chip.classes().filter((c) => c.startsWith("bg-"))).toEqual([]);
    // The brand mark paints white too, over its brand colour.
    expect(ollama.get("[data-cell='status']").classes()).toContain("[&_[data-brand]_path]:fill-current");
    ollama.unmount();

    const airplay = mountRow({ ...byPort(7000), framework: "AirPlay" }, spies(), { selected: true });
    const framework = airplay.get("[data-badge='framework']");
    expect(framework.classes()).toEqual(
      expect.arrayContaining(["border-on-sel-fill/60", "text-on-sel-fill"]),
    );
    expect(framework.classes().filter((c) => c.startsWith("bg-"))).toEqual([]);
    airplay.unmount();

    // Not selected: the soft chips and the brand colours as before.
    const plain = mountRow(byPort(11434), spies());
    expect(plain.get("[data-badge='launchd']").classes()).toEqual(
      expect.arrayContaining(["border-line", "bg-canvas", "text-ink-2"]),
    );
    expect(plain.get("[data-cell='status']").classes()).not.toContain("[&_[data-brand]_path]:fill-current");
    plain.unmount();
  });

  it("hides Kill by opacity alone on a row that is not selected; hover, focus and the selection show it (spec item 5)", () => {
    const plain = mountRow(byPort(3000), spies());
    expect(plain.get("[role='row']").classes()).toContain("group/row");
    const kill = plain.get("button[aria-label='Kill']");
    expect(kill.classes()).toContain("opacity-0");
    expect(kill.classes()).not.toContain("opacity-100");
    expect(kill.classes()).toEqual(
      expect.arrayContaining([
        "group-hover/row:opacity-100",
        "group-focus-within/row:opacity-100",
        "focus-visible:opacity-100",
      ]),
    );
    // Never out of the layout, the tab order or the accessibility tree, and no motion.
    for (const c of ["hidden", "invisible", "collapse", "sr-only", "pointer-events-none"]) {
      expect(kill.classes(), c).not.toContain(c);
    }
    expect(kill.attributes("tabindex")).toBeUndefined();
    expect(kill.attributes("aria-hidden")).toBeUndefined();
    expect(kill.attributes("style")).toBeUndefined();
    expect(kill.text()).toBe("Kill");
    // Today's look on a row that is not selected: a bordered button, red ink, a red fill on its own hover.
    expect(kill.classes()).toEqual(
      expect.arrayContaining([
        "border-line-strong",
        "bg-surface",
        "text-red-ink",
        "hover:bg-red-ink",
        "hover:text-surface",
      ]),
    );
    plain.unmount();

    // The selected row: shown, the white (surface) button with red ink of the mock-up.
    const selected = mountRow(byPort(3000), spies(), { selected: true });
    const shown = selected.get("button[aria-label='Kill']");
    expect(shown.classes()).toContain("opacity-100");
    expect(shown.classes()).not.toContain("opacity-0");
    expect(shown.classes()).toEqual(expect.arrayContaining(["border-surface", "bg-surface", "text-red-ink"]));
    expect(shown.classes()).not.toContain("bg-red-ink");
    selected.unmount();

    // Nothing in a row moves: no transition and no animation (R6; the pending spinner aside).
    for (const s of [false, true]) {
      const wrapper = mountRow(byPort(3000), spies(), { selected: s });
      const moving = everything(wrapper).flatMap((el) =>
        classesOf(el).filter((c) => /(^|:)(transition|duration-|ease-|animate-)/.test(c)),
      );
      expect(moving, `selected ${s}`).toEqual([]);
      wrapper.unmount();
    }
  });

  it("the ⋯ menu has no border and is always visible; white on the selected row", () => {
    const plain = mountRow(byPort(3000), spies());
    const more = plain.get("button[aria-label='More']");
    expect(more.classes().filter((c) => /(^|:)border/.test(c))).toEqual([]);
    expect(more.classes().filter((c) => /(^|:)opacity-/.test(c))).toEqual([]);
    expect(more.classes()).toContain("text-ink-3");
    plain.unmount();

    const selected = mountRow(byPort(3000), spies(), { selected: true });
    const white = selected.get("button[aria-label='More']");
    expect(white.classes()).toContain("text-on-sel-fill");
    expect(white.classes().filter((c) => /(^|:)(border|opacity-|bg-)/.test(c))).toEqual([]);
    selected.unmount();
  });

  it("shows a spinner and no buttons while pending", () => {
    const wrapper = mountRow(byPort(3000), spies(), { pending: true });
    expect(wrapper.find("button[aria-label='Kill']").exists()).toBe(false);
    expect(wrapper.find("button[aria-label='More']").exists()).toBe(false);
    expect(wrapper.find("[aria-label='killing']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("marks a watched row with the eye after the brand mark, and leaves the pills alone (WP-18)", () => {
    const plain = mountRow(byPort(3000), spies());
    expect(plain.find("[data-badge='watched']").exists()).toBe(false);
    plain.unmount();

    const isWatched = (t: { port: number; protocol: string }) => t.port === 3000 && t.protocol === "tcp";
    const watched = mountRow(byPort(3000), spies(), {}, { [WATCHED_KEY as symbol]: isWatched });
    expect(watched.get("[data-badge='watched']").classes()).toContain("text-blue-ink");
    expect(pillsOf(watched)).toEqual([
      ["running", "Running"],
      ["watched", ""],
    ]);
    watched.unmount();

    const other = mountRow(byPort(5173), spies(), {}, { [WATCHED_KEY as symbol]: isWatched });
    expect(other.find("[data-badge='watched']").exists()).toBe(false);
    other.unmount();
  });

  it("the row menu has Hide :PORT right after Watch and asks for it; a stdio row's Hide port is off", async () => {
    /** Opens the row menu (it renders in a portal on the body) and returns its items. */
    const openMenu = async (wrapper: ReturnType<typeof mountRow>) => {
      await wrapper.get("button[aria-label='More']").trigger("click");
      await flushPromises();
      return [...document.body.querySelectorAll<HTMLElement>("[role='menu'] [role='menuitem']")];
    };

    const actions = spies();
    const airplay = mountRow(byPort(7000), actions);
    const items = await openMenu(airplay);
    const labels = items.map((item) => item.textContent?.trim());
    expect(labels).toContain("Hide :7000");
    expect(labels.indexOf("Hide :7000")).toBe(labels.indexOf("Watch :7000") + 1);
    const hide = items.find((item) => item.dataset.action === "hide");
    expect(hide?.getAttribute("aria-disabled")).toBeNull();
    hide?.click();
    await flushPromises();
    expect(actions.hide).toHaveBeenCalledTimes(1);
    expect(actions.hide).toHaveBeenCalledWith(byPort(7000));
    expect(actions.inspect).not.toHaveBeenCalled();
    airplay.unmount();

    const mcp: PortEntry = { ...byPort(5174), port: 0, pid: 61204, address: "stdio" };
    const stdio = mountRow(mcp, actions);
    const stdioHide = (await openMenu(stdio)).find((item) => item.dataset.action === "hide");
    expect(stdioHide?.textContent?.trim()).toBe("Hide port");
    expect(stdioHide?.getAttribute("aria-disabled")).toBe("true");
    stdioHide?.click();
    await flushPromises();
    expect(actions.hide).toHaveBeenCalledTimes(1);
    stdio.unmount();
  });

  it("renders stdio instead of 0 for a portless orphan row (WP-23)", () => {
    const mcp: PortEntry = {
      ...byPort(5174),
      port: 0,
      pid: 61204,
      address: "stdio",
      processName: "mcp-server-filesystem",
      category: "ai",
      framework: "MCP",
    };
    const row = mountRow(mcp, spies());
    expect(row.get("[role='row'] > span").text()).toBe("stdio");
    expect(pillsOf(row)).toEqual([
      ["zombie", "Zombie"],
      ["ai", "AI · 220 MB"],
      ["framework", "MCP"],
    ]);
    row.unmount();
  });
});
