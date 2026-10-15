/**
 * The contract with the Rust core. Mirrors `src-tauri/src/model.rs` field for field:
 * camelCase keys, lowercase enum values, `status`-tagged outcomes. Change both files in the
 * same commit.
 */

export type Protocol = "tcp" | "udp";

/** Who can reach a port: only this machine (`loopback`), the whole network (`any`), or one interface. */
export type BindScope = "loopback" | "any" | "other";

export type ProjectKind = "node" | "rust" | "python" | "go" | "git" | "unknown";

/**
 * Port taxonomy (v0.2): `web` dev servers (3000–3010, 5173+, 4200), `api` backends (8000, 8080,
 * 5000, 4000), `db` databases and caches (always protected), `ai` local model servers (11434
 * Ollama, 1234 LM Studio, 8001 vLLM; heavy on memory), `system` macOS daemons (always protected).
 */
export type Category = "web" | "api" | "db" | "ai" | "system" | "other";

export interface ProjectInfo {
  /** `name` from package.json or Cargo.toml, else the folder name. */
  name: string;
  root: string;
  kind: ProjectKind;
  branch: string | null;
  /** What is running, read from the command line: `vite`, `next`, `nest`, `node`, `docker`, `postgres`... */
  tool: string | null;
}

export interface PortEntry {
  port: number;
  protocol: Protocol;
  bind: BindScope;
  /** The literal bind address, e.g. `127.0.0.1`, `0.0.0.0`, `::`. */
  address: string;
  pid: number;
  processName: string;
  /** The full command line. Empty when the OS will not tell us. */
  command: string;
  cwd: string | null;
  exe: string | null;
  user: string | null;
  memoryBytes: number;
  /** Unix seconds, or null when unknown. */
  startedAt: number | null;
  parentPid: number | null;
  /** The parent died and launchd adopted it. Usually a stray dev server. */
  orphan: boolean;
  project: ProjectInfo | null;
  /** Needs a second confirmation before killing (databases, Docker, system daemons). */
  protected: boolean;
  category: Category;
  /** A human name for the stack behind the port: `Next.js`, `NestJS`, `PostgreSQL`, `Ollama`... */
  framework: string | null;
}

export interface KillRequest {
  pid: number;
  /** `true` sends SIGKILL at once. `false` sends SIGTERM, waits up to 3 s, then SIGKILL. */
  force: boolean;
}

export type KillOutcome =
  | { status: "killed"; pid: number; graceful: boolean; waitedMs: number }
  | { status: "notFound"; pid: number }
  | { status: "refused"; pid: number; reason: string }
  | { status: "failed"; pid: number; error: string };

/** One link of a process's ancestry, launchd first, the process itself last. */
export interface ProcessNode {
  pid: number;
  name: string;
}

export type EventKind =
  | "portFreed"
  | "forceKilled"
  | "zombieReaped"
  | "collisionResolved"
  | "relaunched"
  | "refused"
  | "failed";

/** What happened, for the Taskline. Recorded by the core, so the tray's kills show up too. */
export interface TasklineEvent {
  id: number;
  /** Unix milliseconds. */
  atMs: number;
  kind: EventKind;
  port: number;
  protocol: Protocol;
  pid: number;
  processName: string;
  project: string | null;
  /** Memory the process held when it was killed (what the kill gave back). */
  memoryBytes: number;
  /** How long the kill took, signal to exit. */
  durationMs: number;
  /** One sentence for the feed. */
  message: string;
  /** The core remembers the command and cwd, so "Relaunch" can bring it back. */
  relaunchable: boolean;
}

export type RelaunchOutcome =
  | { status: "started"; pid: number }
  | { status: "notFound"; eventId: number }
  | { status: "failed"; eventId: number; error: string };

/** What the UI can ask the core to do. Implemented by `api/tauri.ts` and `api/mock.ts`. */
export interface PortApi {
  listPorts(): Promise<PortEntry[]>;
  killProcess(request: KillRequest): Promise<KillOutcome>;
  /** Kills every process on `port`. One outcome per distinct pid. */
  freePort(port: number, force: boolean): Promise<KillOutcome[]>;
  appVersion(): Promise<string>;
  /** Ancestry of a process, launchd first. Empty when unknown. */
  processTree(pid: number): Promise<ProcessNode[]>;
  /** Everything PortReaper did this session, newest first. */
  tasklineEvents(): Promise<TasklineEvent[]>;
  clearTaskline(): Promise<void>;
  /** Starts a killed process again from the command and cwd remembered for that event. */
  relaunch(eventId: number): Promise<RelaunchOutcome>;
  /** Kills every lost-terminal (orphan, unprotected) process. One outcome per pid; each lands in the Taskline as `zombieReaped`. */
  reapZombies(): Promise<KillOutcome[]>;
}
