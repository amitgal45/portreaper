import type { SimpleIcon } from "simple-icons";
import {
  siAngular,
  siAstro,
  siBun,
  siClickhouse,
  siDeno,
  siDjango,
  siDocker,
  siElasticsearch,
  siExpress,
  siFastapi,
  siFlask,
  siGo,
  siJekyll,
  siJest,
  siLaravel,
  siLmstudio,
  siMariadb,
  siMongodb,
  siMysql,
  siNestjs,
  siNextdotjs,
  siNodedotjs,
  siNuxt,
  siOllama,
  siPhp,
  siPostgresql,
  siPython,
  siRedis,
  siRemix,
  siRuby,
  siRubyonrails,
  siRust,
  siSpring,
  siStorybook,
  siVite,
  siVitest,
  siVllm,
  siWebpack,
} from "simple-icons";
import type { PortEntry } from "../types";

/** What a row shows instead of a framework name: a brand mark with its own colour. */
export interface BrandIcon {
  /** The brand's name, for the tooltip and the accessible label. */
  title: string;
  /** SVG path data on a 24×24 viewBox (simple-icons). */
  path: string;
  /** The brand colour, `#rrggbb`. Near-black brands are drawn in the text colour instead. */
  color: string;
}

/** Framework names as the core's `classify` and the mock write them, lowercased. */
const BY_FRAMEWORK: Record<string, SimpleIcon> = {
  "next.js": siNextdotjs,
  vite: siVite,
  nuxt: siNuxt,
  nestjs: siNestjs,
  fastapi: siFastapi,
  django: siDjango,
  flask: siFlask,
  rails: siRubyonrails,
  express: siExpress,
  angular: siAngular,
  astro: siAstro,
  remix: siRemix,
  storybook: siStorybook,
  webpack: siWebpack,
  vitest: siVitest,
  jest: siJest,
  jekyll: siJekyll,
  laravel: siLaravel,
  spring: siSpring,
  go: siGo,
  postgresql: siPostgresql,
  mysql: siMysql,
  mariadb: siMariadb,
  mongodb: siMongodb,
  redis: siRedis,
  elasticsearch: siElasticsearch,
  clickhouse: siClickhouse,
  ollama: siOllama,
  "lm studio": siLmstudio,
  vllm: siVllm,
  docker: siDocker,
};

/** Process names (the executable's file name, lowercased) when the framework says nothing. */
const BY_PROCESS: Record<string, SimpleIcon> = {
  node: siNodedotjs,
  nodejs: siNodedotjs,
  bun: siBun,
  deno: siDeno,
  python: siPython,
  python3: siPython,
  ruby: siRuby,
  go: siGo,
  php: siPhp,
  java: siSpring,
  postgres: siPostgresql,
  mysqld: siMysql,
  mariadbd: siMariadb,
  mongod: siMongodb,
  "redis-server": siRedis,
  ollama: siOllama,
  "com.docker.backend": siDocker,
  docker: siDocker,
  dockerd: siDocker,
  cargo: siRust,
};

function toIcon(icon: SimpleIcon): BrandIcon {
  return { title: icon.title, path: icon.path, color: `#${icon.hex}` };
}

/**
 * The brand mark for an entry, or `null` when the stack is unknown: the row then falls back to a
 * text pill. Framework first (`Next.js` beats `node`), then Docker's mark for a container whose
 * image names nothing we draw (WP-20), then the process name; a framework like `PostgreSQL 16`
 * matches on its first word.
 */
export function brandIcon(
  entry: Pick<PortEntry, "framework" | "processName"> & { container?: string | null },
): BrandIcon | null {
  const framework = entry.framework?.toLowerCase().trim();
  if (framework) {
    const exact = BY_FRAMEWORK[framework];
    if (exact) return toIcon(exact);
    const firstWord = framework.split(/\s+/)[0] ?? "";
    const byWord = BY_FRAMEWORK[firstWord];
    if (byWord) return toIcon(byWord);
  }
  if (entry.container) return toIcon(siDocker);
  const process = entry.processName.toLowerCase().trim();
  const byProcess = BY_PROCESS[process];
  return byProcess ? toIcon(byProcess) : null;
}

/** Brands drawn in black need the text colour on a dark surface. */
export function isNearBlack(color: string): boolean {
  const n = Number.parseInt(color.replace("#", ""), 16);
  if (Number.isNaN(n)) return false;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 60;
}
