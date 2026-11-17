/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { APP_ICON, ECHO, LEFT_BRACKET, RIGHT_BRACKET } from "../lib/app-icon";
import AppMark from "./AppMark.vue";

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const urlRef = /^url\(#(.+)\)$/;

describe("AppMark", () => {
  it("draws the plate, the echo plate and the two brackets, warm left and cool right, hidden from assistive technology", () => {
    const wrapper = mount(AppMark);
    const svg = wrapper.get("svg[data-app-mark]");
    expect(svg.attributes("aria-hidden")).toBe("true");
    expect(svg.attributes("viewBox")).toBe("100 100 824 824");
    const stops = (fill: string | undefined) =>
      svg
        .findAll(`linearGradient[id="${fill?.match(urlRef)?.[1]}"] stop`)
        .map((s) => s.attributes("stop-color"));
    expect(stops(svg.get("rect[rx='185']").attributes("fill"))).toEqual([...APP_ICON.plate]);
    expect(svg.get(`rect[width='${ECHO.width}']`).attributes("rx")).toBe(String(ECHO.rx));
    const [left, right] = svg.findAll("path");
    expect(left?.attributes("d")).toBe(LEFT_BRACKET);
    expect(right?.attributes("d")).toBe(RIGHT_BRACKET);
    expect(stops(left?.attributes("fill"))).toEqual([...APP_ICON.warm]);
    expect(stops(right?.attributes("fill"))).toEqual([...APP_ICON.cool]);
  });

  it("gives every mark on a page its own ids, so two never share a gradient", () => {
    const Two = defineComponent({ render: () => h("div", [h(AppMark), h(AppMark)]) });
    const wrapper = mount(Two);
    const ids = wrapper.findAll("[id]").map((el) => el.attributes("id"));
    expect(ids.length).toBe(8);
    expect(new Set(ids).size).toBe(ids.length);
    // Every reference points at an id of its own mark.
    for (const svg of wrapper.findAll("svg[data-app-mark]")) {
      const own = new Set(svg.findAll("[id]").map((el) => el.attributes("id")));
      const refs = svg
        .findAll("[fill]")
        .map((el) => el.attributes("fill")?.match(urlRef)?.[1])
        .filter((ref): ref is string => ref !== undefined);
      expect(refs.length).toBe(4);
      for (const ref of refs) expect(own.has(ref)).toBe(true);
    }
  });
});

describe("the app icon's sources", () => {
  it("lib/app-icon.ts and design/icon.svg agree on the plate, the brackets and the echo plate", () => {
    const icon = read("design/icon.svg");
    const stopsOf = (id: string) => {
      const gradient =
        icon.match(new RegExp(`<linearGradient id="${id}"[\\s\\S]*?</linearGradient>`))?.[0] ?? "";
      return [...gradient.matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
    };
    expect(stopsOf("bg-grad")).toEqual([...APP_ICON.plate]);
    expect(stopsOf("prism-left")).toEqual([...APP_ICON.warm]);
    expect(stopsOf("prism-right")).toEqual([...APP_ICON.cool]);
    expect(stopsOf("echo-glass")).toEqual([...APP_ICON.glass]);
    const { x, y, width, height, rx } = ECHO;
    expect(icon).toContain(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}"`);
  });

  it("every design source draws the same two brackets as the in-app mark", () => {
    for (const file of [
      "design/icon.svg",
      "design/icon-dark.svg",
      "design/icon-tinted.svg",
      "design/glyph.svg",
    ]) {
      const svg = read(file);
      expect(svg, `${file}: the left bracket`).toContain(LEFT_BRACKET);
      expect(svg, `${file}: the right bracket`).toContain(RIGHT_BRACKET);
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
