/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { APP_ICON, CUT, LEFT, OPENING, RIGHT, SOCKET } from "../lib/app-icon";
import AppMark from "./AppMark.vue";

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const urlRef = /^url\(#(.+)\)$/;

describe("AppMark", () => {
  it("draws the plate and the socket in two pieces, warm left and cool right, hidden from assistive technology", () => {
    const wrapper = mount(AppMark);
    const svg = wrapper.get("svg[data-app-mark]");
    expect(svg.attributes("aria-hidden")).toBe("true");
    expect(svg.attributes("viewBox")).toBe("100 100 824 824");
    expect(svg.get("rect[rx]").attributes("fill")).toBe(APP_ICON.plate);
    const pieces = svg.findAll("g[mask] > path[clip-path]");
    expect(pieces).toHaveLength(2);
    const stops = (gradient: string) =>
      svg.findAll(`linearGradient[id="${gradient}"] stop`).map((s) => s.attributes("stop-color"));
    const fillOf = (piece: (typeof pieces)[number]) => piece.attributes("fill")?.match(urlRef)?.[1] ?? "";
    const [left, right] = pieces;
    expect(left && stops(fillOf(left))).toEqual([...APP_ICON.warm]);
    expect(right && stops(fillOf(right))).toEqual([...APP_ICON.cool]);
  });

  it("gives every mark on a page its own ids, so two never share a gradient, a clip or the cut", () => {
    const Two = defineComponent({ render: () => h("div", [h(AppMark), h(AppMark)]) });
    const wrapper = mount(Two);
    const ids = wrapper.findAll("[id]").map((el) => el.attributes("id"));
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(ids.length);
    // Every reference points at an id of its own mark.
    for (const svg of wrapper.findAll("svg[data-app-mark]")) {
      const own = new Set(svg.findAll("[id]").map((el) => el.attributes("id")));
      const refs = svg
        .findAll("[mask], [fill], [clip-path]")
        .flatMap((el) => ["mask", "fill", "clip-path"].map((a) => el.attributes(a)?.match(urlRef)?.[1]))
        .filter((ref): ref is string => ref !== undefined);
      expect(refs.length).toBe(5);
      for (const ref of refs) expect(own.has(ref)).toBe(true);
    }
  });
});

describe("the app icon's sources", () => {
  it("lib/app-icon.ts and design/icon.svg agree on the gradients", () => {
    const icon = read("design/icon.svg");
    const stopsOf = (id: string) => {
      const gradient =
        icon.match(new RegExp(`<linearGradient id="${id}"[\\s\\S]*?</linearGradient>`))?.[0] ?? "";
      return [...gradient.matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
    };
    expect(stopsOf("warm")).toEqual([...APP_ICON.warm]);
    expect(stopsOf("cool")).toEqual([...APP_ICON.cool]);
  });

  it("every design source draws the same socket, opening and cut as the in-app mark", () => {
    for (const file of [
      "design/icon.svg",
      "design/icon-dark.svg",
      "design/icon-tinted.svg",
      "design/glyph.svg",
    ]) {
      const svg = read(file);
      expect(svg, `${file}: the socket`).toContain(`"${SOCKET}"`);
      expect(svg, `${file}: the cut`).toContain(`"${CUT}"`);
    }
    for (const file of ["design/icon.svg", "design/icon-dark.svg"]) {
      const svg = read(file);
      expect(svg, `${file}: the warm piece's clip`).toContain(`"${LEFT}"`);
      expect(svg, `${file}: the cool piece's clip`).toContain(`"${RIGHT}"`);
      expect(svg, `${file}: the glass`).toContain(`"${OPENING}"`);
    }
  });

  it("only the in-app mark imports the icon's colours: everything else uses tokens", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
          if (/from "[./]*\/?(?:lib\/)?app-icon"/.test(readFileSync(path, "utf8"))) {
            importers.push(relative(root, path));
          }
        }
      }
    };
    walk(resolve(root, "src"));
    expect(importers).toEqual(["src/components/AppMark.vue"]);
  });
});
