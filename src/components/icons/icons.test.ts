/// <reference types="node" />
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { Component } from "vue";
import {
  ClockIcon,
  DbIcon,
  DotIcon,
  EyeIcon,
  GearIcon,
  GlobeIcon,
  GridIcon,
  ReapIcon,
  SparkIcon,
  TermIcon,
  ZapIcon,
} from "./index";

/**
 * Our own icons (spec item 8): the mock-up's SVG symbols, one component each, on a 24 grid with
 * round caps and joins in currentColor. The children are the mock's markup, verbatim
 * (portreaper-meta product/design/2026-11-19-refresh-b3-native.html at 482b4cd), serialised the
 * way the DOM writes them back.
 */
const SYMBOLS: [name: string, icon: Component, markup: string][] = [
  [
    "grid",
    GridIcon,
    '<path d="M3 10.5A2.5 2.5 0 0 1 5.5 8H8V4h8v4h2.5a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"></path><path d="M9 14.5v2M12 14.5v2M15 14.5v2"></path>',
  ],
  [
    "term",
    TermIcon,
    '<rect x="3.5" y="5" width="17" height="14" rx="2.5"></rect><path d="M7.5 10l2.5 2.25-2.5 2.25M12.5 14.5h4"></path>',
  ],
  [
    "spark",
    SparkIcon,
    '<path d="M11 5c.5 3.4 2.1 5 5.5 5.5-3.4.5-5 2.1-5.5 5.5-.5-3.4-2.1-5-5.5-5.5 3.4-.5 5-2.1 5.5-5.5z"></path><path d="M18 14.5v4M16 16.5h4"></path>',
  ],
  [
    "db",
    DbIcon,
    '<ellipse cx="12" cy="6.5" rx="7" ry="2.5"></ellipse><path d="M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"></path>',
  ],
  ["zap", ZapIcon, '<path d="M3.5 10h8l-8 9.5h8"></path><path d="M14.5 4.5h6l-6 7h6"></path>'],
  [
    "reap",
    ReapIcon,
    '<path d="M5 21 13.5 3.5"></path><path d="M13.5 3.5c4.4 0 7.4 2.3 8 6.3-2.7-2-5.6-2.7-9.6-2.1"></path>',
  ],
  [
    "globe",
    GlobeIcon,
    '<circle cx="12" cy="16.5" r="1.5"></circle><path d="M8.5 13a5 5 0 0 1 7 0M5.5 10a9 9 0 0 1 13 0"></path><path d="M3 20.5h18"></path>',
  ],
  [
    "eye",
    EyeIcon,
    '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.75"></circle>',
  ],
  [
    "clock",
    ClockIcon,
    '<path d="M5 4v16"></path><circle cx="5" cy="7" r="1.5" fill="currentColor"></circle><circle cx="5" cy="17" r="1.5" fill="currentColor"></circle><path d="M10 7h10M10 17h7M10 12h4"></path>',
  ],
  ["dot", DotIcon, '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"></circle>'],
  [
    "gear",
    GearIcon,
    '<path d="M4 8h8.5M17.5 8H20M4 16h2.5M11.5 16H20"></path><circle cx="15" cy="8" r="2.5"></circle><circle cx="9" cy="16" r="2.5"></circle>',
  ],
];

describe.each(SYMBOLS)("the %s icon", (_name, icon, markup) => {
  it("is the mock's symbol on a 24 grid: 15 px, stroke 1.75, round, currentColor, hidden from assistive tech", () => {
    const svg = mount(icon).get("svg");
    expect(svg.attributes()).toMatchObject({
      viewBox: "0 0 24 24",
      width: "15",
      height: "15",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.75",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    });
    expect(svg.element.innerHTML).toBe(markup);
    // Not a lucide icon: the `.lucide` stroke rule in style.css is not what sets its weight.
    expect(svg.classes()).not.toContain("lucide");
  });

  it("takes size and strokeWidth like a lucide icon, and passes a class through", () => {
    const svg = mount(icon, { props: { size: 20, strokeWidth: 2 }, attrs: { class: "text-brand" } }).get(
      "svg",
    );
    expect(svg.attributes()).toMatchObject({ width: "20", height: "20", "stroke-width": "2" });
    expect(svg.classes()).toContain("text-brand");
  });
});

describe("the icon set", () => {
  it("is the eleven symbols and nothing else: no plug (decisions 2026-11-23)", () => {
    const dir = resolve(process.cwd(), "src/components/icons");
    const icons = readdirSync(dir)
      .filter((f) => f.endsWith("Icon.vue"))
      .sort();
    expect(icons).toEqual(
      [
        "ClockIcon.vue",
        "DbIcon.vue",
        "DotIcon.vue",
        "EyeIcon.vue",
        "GearIcon.vue",
        "GlobeIcon.vue",
        "GridIcon.vue",
        "ReapIcon.vue",
        "SparkIcon.vue",
        "TermIcon.vue",
        "ZapIcon.vue",
      ].sort(),
    );
  });
});
