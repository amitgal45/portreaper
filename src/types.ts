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
  /** The Docker container publishing this port when Docker's backend holds it (WP-20); null for every other process. */
  container: string | null;
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

/** A newer release the core found on GitHub: the payload of `update:available` (WP-16). */
export interface UpdateInfo {
  /** As `latest.json` announces it: `0.3.0`. */
  version: string;
  /** The release notes, or null when the release has none. */
  notes: string | null;
  /** The release's publish date, RFC 3339, or null. */
  date: string | null;
}

/** The payload of `update:progress`, about every 256 kB while the update downloads. */
export interface UpdateProgress {
  downloaded: number;
  /** The download's size in bytes, or null when the server did not say. */
  total: number | null;
}

/** The payload of `update:error`: the download or the install failed; the app keeps running. */
export interface UpdateFailure {
  message: string;
}

/** `show`: a regular app with a Dock icon. `hide`: menu bar only. */
export type DockIcon = "show" | "hide";

/**
 * The user's preferences (WP-17). Stored by the core, applied live, announced as
 * `settings:changed`. Mirrors `Settings` in `model.rs`, defaults included.
 */
export interface Settings {
  dockIcon: DockIcon;
  startAtLogin: boolean;
  /** The Quick window's global shortcut, in the global-shortcut plugin's syntax: `CmdOrCtrl+Shift+K`. */
  quickShortcut: string;
  /** The main window's global shortcut. */
  windowShortcut: string;
  /** How often the UI and the tray re-read the ports: 1 000–30 000 ms. */
  refreshMs: number;
  /** Kill sends SIGKILL at once; ⌥ flips it either way. */
  defaultForce: boolean;
  /** macOS notifications for tray kills and watched ports. */
  notifications: boolean;
  /** The first-run card was dismissed. */
  onboardingDone: boolean;
}

/** `impl Default for Settings` in `model.rs`, field for field. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  dockIcon: "show",
  startAtLogin: true,
  quickShortcut: "CmdOrCtrl+Shift+K",
  windowShortcut: "CmdOrCtrl+Shift+P",
  refreshMs: 2000,
  defaultForce: false,
  notifications: true,
  onboardingDone: false,
});

export type WatchState = "listening" | "free";

/** A port the user watches (WP-18): the core notifies when its state changes. */
export interface WatchedPort {
  port: number;
  protocol: Protocol;
  state: WatchState;
  /** The process holding the port while `listening`; the last holder while `free`, if known. */
  pid: number | null;
  processName: string | null;
  project: string | null;
  /** Unix milliseconds: when the current state began. */
  sinceMs: number;
}

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
  /**
   * Checks GitHub Releases now and tells the user in a native dialog: the offer, "You're up to
   * date", or why it could not check. Resolves when the dialog closed; never when the user took
   * the update, because the app relaunches.
   */
  checkForUpdates(): Promise<void>;
  /**
   * Downloads and installs the update the last check found (the banner's Update and Retry), then
   * relaunches. Rejects with what the user should read when nothing was found yet or it failed.
   */
  installUpdate(): Promise<void>;
  /** The preferences (WP-17), with the live start-at-login state. */
  getSettings(): Promise<Settings>;
  /**
   * Stores and applies `settings`; resolves with the effective value. Rejects with the field that
   * could not be applied (a shortcut another app owns); everything else stands.
   */
  setSettings(settings: Settings): Promise<Settings>;
  /** Every watched port with its current state (WP-18). */
  watchedPorts(): Promise<WatchedPort[]>;
  /** Both resolve with the full list afterwards. */
  watchPort(port: number, protocol: Protocol): Promise<WatchedPort[]>;
  unwatchPort(port: number, protocol: Protocol): Promise<WatchedPort[]>;
}
