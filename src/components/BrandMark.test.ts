/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { BRAND } from "../lib/brand";
import BrandMark from "./BrandMark.vue";

const urlRef = /^url\(#(.+)\)$/;

describe("BrandMark", () => {
  it("draws the plate and the socket in two pieces, warm left and cool right, hidden from assistive technology", () => {
    const wrapper = mount(BrandMark);
    const svg = wrapper.get("svg[data-brand-mark]");
    expect(svg.attributes("aria-hidden")).toBe("true");
    expect(svg.attributes("viewBox")).toBe("100 100 824 824");
    expect(svg.get("rect[rx]").attributes("fill")).toBe(BRAND.plate);
    const pieces = svg.findAll("g[mask] > path");
    expect(pieces).toHaveLength(2);
    const stops = (gradient: string) =>
      svg.findAll(`linearGradient[id="${gradient}"] stop`).map((s) => s.attributes("stop-color"));
    const fillOf = (piece: (typeof pieces)[number]) => piece.attributes("fill")?.match(urlRef)?.[1] ?? "";
    const [left, right] = pieces;
    expect(left && stops(fillOf(left))).toEqual([...BRAND.warm]);
    expect(right && stops(fillOf(right))).toEqual([...BRAND.cool]);
  });

  it("gives every mark on a page its own ids, so two never share a gradient, a clip or the cut", () => {
    const Two = defineComponent({ render: () => h("div", [h(BrandMark), h(BrandMark)]) });
    const wrapper = mount(Two);
    const ids = wrapper.findAll("[id]").map((el) => el.attributes("id"));
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(ids.length);
    // Every reference points at an id of its own mark.
    for (const svg of wrapper.findAll("svg[data-brand-mark]")) {
      const own = new Set(svg.findAll("[id]").map((el) => el.attributes("id")));
      const refs = svg
        .findAll("[mask], [fill], [clip-path]")
        .flatMap((el) => ["mask", "fill", "clip-path"].map((a) => el.attributes(a)?.match(urlRef)?.[1]))
        .filter((ref): ref is string => ref !== undefined);
      expect(refs.length).toBe(5);
      for (const ref of refs) expect(own.has(ref)).toBe(true);
    }
  });

  it("uses the app icon's colours: lib/brand.ts and design/icon.svg's gradients agree", () => {
    // Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
    const icon = readFileSync(resolve(process.cwd(), "design/icon.svg"), "utf8");
    const stopsOf = (id: string) => {
      const gradient =
        icon.match(new RegExp(`<linearGradient id="${id}"[\\s\\S]*?</linearGradient>`))?.[0] ?? "";
      return [...gradient.matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
    };
    expect(stopsOf("warm")).toEqual([...BRAND.warm]);
    expect(stopsOf("cool")).toEqual([...BRAND.cool]);
  });
});
