import { describe, expect, it } from "vitest";
import { brandIcon, isNearBlack } from "./brand-icons";

describe("brandIcon", () => {
  it.each([
    [{ framework: "Next.js", processName: "node" }, "Next.js"],
    [{ framework: "Vite", processName: "node" }, "Vite"],
    [{ framework: "NestJS", processName: "node" }, "NestJS"],
    [{ framework: "PostgreSQL 16", processName: "com.docker.backend" }, "PostgreSQL"],
    [{ framework: "Redis 7", processName: "com.docker.backend" }, "Redis"],
    [{ framework: "Ollama", processName: "ollama" }, "Ollama"],
    [{ framework: "Jekyll", processName: "ruby" }, "Jekyll"],
    [{ framework: "FastAPI", processName: "python3" }, "FastAPI"],
  ])("names the framework first: %o → %s", (entry, title) => {
    expect(brandIcon(entry)?.title).toBe(title);
  });

  it.each([
    [{ framework: null, processName: "node" }, "Node.js"],
    [{ framework: null, processName: "python3" }, "Python"],
    [{ framework: null, processName: "com.docker.backend" }, "Docker"],
    [{ framework: null, processName: "ruby" }, "Ruby"],
  ])("falls back to the process: %o → %s", (entry, title) => {
    expect(brandIcon(entry)?.title).toBe(title);
  });

  it.each([
    [{ framework: "ghcr.io/acme/shop-api", processName: "com.docker.backend", container: "api" }, "Docker"],
    [{ framework: null, processName: "vpnkit", container: "api" }, "Docker"],
    [{ framework: "busybox", processName: "docker-proxy", container: "idle" }, "Docker"],
  ])("picks Docker for a container entry without a framework icon: %o → %s", (entry, title) => {
    expect(brandIcon(entry)?.title).toBe(title);
  });

  it("lets a known framework win over a container's Docker mark", () => {
    const entry = { framework: "PostgreSQL 16", processName: "com.docker.backend", container: "shop-db" };
    expect(brandIcon(entry)?.title).toBe("PostgreSQL");
    expect(brandIcon({ ...entry, container: null })?.title).toBe("PostgreSQL");
  });

  it("is null for an unknown stack, so the row shows a text pill", () => {
    expect(brandIcon({ framework: null, processName: "mDNSResponder" })).toBeNull();
    expect(brandIcon({ framework: "Something New", processName: "chrome-helper" })).toBeNull();
  });

  it("carries a 24-viewBox path and a hex colour", () => {
    const icon = brandIcon({ framework: "Vite", processName: "node" });
    expect(icon?.path).toMatch(/^M/);
    expect(icon?.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("knows which brands are drawn in black", () => {
    expect(isNearBlack("#000000")).toBe(true);
    expect(isNearBlack("#9135FF")).toBe(false);
    expect(isNearBlack("not a colour")).toBe(false);
  });
});
