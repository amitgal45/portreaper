/**
 * The contract with the Rust core. Mirrors `src-tauri/src/model.rs` field for field:
 * camelCase keys, lowercase enum values, `status`-tagged outcomes. Change both files in the
 * same commit.
 */

export type Protocol = "tcp" | "udp";

/** Who can reach a port: only this machine (`loopback`), the whole network (`any`), or one interface. */
export type BindScope = "loopback" | "any" | "other";

export type ProjectKind = "node" | "rust" | "python" | "go" | "git" | "unknown";

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

/** What the UI can ask the core to do. Implemented by `api/tauri.ts` and `api/mock.ts`. */
export interface PortApi {
  listPorts(): Promise<PortEntry[]>;
  killProcess(request: KillRequest): Promise<KillOutcome>;
  /** Kills every process on `port`. One outcome per distinct pid. */
  freePort(port: number, force: boolean): Promise<KillOutcome[]>;
  appVersion(): Promise<string>;
}
