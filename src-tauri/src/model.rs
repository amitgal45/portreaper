//! The contract between the Rust core and the Vue UI.
//!
//! `src/types.ts` mirrors every type here field for field. Change both in the same commit,
//! and keep the serde attributes: the UI reads camelCase keys and lowercase enum values.

use serde::{Deserialize, Serialize};

/// One listening socket, enriched with everything the UI shows about the process behind it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortEntry {
    pub port: u16,
    pub protocol: Protocol,
    /// Who can reach this port: only this machine, or the whole network.
    pub bind: BindScope,
    /// The literal bind address, e.g. `127.0.0.1`, `0.0.0.0`, `::`.
    pub address: String,
    pub pid: u32,
    pub process_name: String,
    /// The full command line, joined with spaces. Empty when the OS will not tell us.
    pub command: String,
    pub cwd: Option<String>,
    pub exe: Option<String>,
    pub user: Option<String>,
    pub memory_bytes: u64,
    /// Unix seconds. `None` when unknown.
    pub started_at: Option<u64>,
    pub parent_pid: Option<u32>,
    /// The parent died, so the process was re-parented to launchd (pid 1). Usually a stray dev server.
    pub orphan: bool,
    pub project: Option<ProjectInfo>,
    /// Killing this needs a second confirmation in the UI (databases, Docker, system daemons).
    pub protected: bool,
    pub category: Category,
    /// A human name for the stack behind the port: `Next.js`, `NestJS`, `PostgreSQL`, `Ollama`...
    pub framework: Option<String>,
    /// The Docker container publishing this port when Docker's backend holds it (WP-20).
    /// `None` for every other process.
    pub container: Option<String>,
    /// The launchd job behind this process: its own job, or its parent's (then with
    /// `restarts: None`: its parent, not launchd, decides whether it comes back), when launchd
    /// runs it in the user's domain (a `brew services` formula, any LaunchAgent).
    /// `None` for every other process.
    pub launchd: Option<LaunchdJob>,
}

/// The launchd job behind a process, when launchd runs it in the user's domain (a
/// `brew services` formula, any LaunchAgent). Such a process is never an orphan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchdJob {
    pub label: String,
    /// `Some(true)`: launchd starts it again within seconds of a kill (KeepAlive). `Some(false)`:
    /// it stays down until the job is loaded again (the next login). `None`: unknown (no readable
    /// plist, a conditional KeepAlive, a job launchd also starts on demand, or a job's child).
    /// Anything but `Some(false)` makes the entry `protected`: a kill launchd may undo asks first.
    pub restarts: Option<bool>,
    /// The Homebrew formula, when `brew services` started it.
    pub brew: Option<String>,
    /// What stops it for good, for the user to copy: `brew services stop <formula>`, else
    /// `launchctl disable gui/<uid>/<label> && launchctl bootout gui/<uid>/<label>` (disabled, so
    /// the next login does not load it again). `None` when the label is not safe to put in a shell,
    /// for one of Apple's jobs (`com.apple.*`), and for a process that runs from the system's
    /// folders or from an exe nobody knows: a piece of macOS is not the user's to disable.
    pub stop_command: Option<String>,
    /// An Apple job, or one run from the system's folders: no stop command, and the UI calls it a
    /// system process. Apple's: its label starts with `com.apple.`, in any case. The system's
    /// folders: the process's exe is under `ports::SYSTEM_PREFIXES`. An exe nobody knows withholds
    /// the stop command, but does not make a job a system one.
    pub system: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Tcp,
    Udp,
}

/// Port taxonomy (v0.2): `Web` dev servers (3000–3010, 5173+, 4200), `Api` backends (8000, 8080,
/// 5000, 4000), `Db` databases and caches (always protected), `Ai` local model servers (11434
/// Ollama, 1234 LM Studio, 8001 vLLM; heavy on memory), `System` macOS daemons (always protected).
/// Decided by `crate::classify`, so the tray, the HUD and the Studio agree.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Web,
    Api,
    Db,
    Ai,
    System,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BindScope {
    /// 127.0.0.1, ::1 — reachable from this machine only.
    Loopback,
    /// 0.0.0.0, :: — reachable from the whole network.
    Any,
    /// A specific interface address.
    Other,
}

/// The repository or package a process runs from, found by walking up from its working directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// `name` from package.json or Cargo.toml, else the folder name.
    pub name: String,
    pub root: String,
    pub kind: ProjectKind,
    pub branch: Option<String>,
    /// What is running, read from the command line: `vite`, `next`, `nest`, `node`, `docker`, `postgres`...
    pub tool: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectKind {
    Node,
    Rust,
    Python,
    Go,
    /// A git repository with no recognised package manifest.
    Git,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KillRequest {
    pub pid: u32,
    /// `true` sends SIGKILL at once. `false` sends SIGTERM, waits, then SIGKILL if still alive.
    pub force: bool,
}

// `rename_all` on the enum renames the variants (the `status` values); the one on each variant
// renames its fields. Both are needed for `waitedMs`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum KillOutcome {
    #[serde(rename_all = "camelCase")]
    Killed {
        pid: u32,
        /// `true` when SIGTERM was enough.
        graceful: bool,
        waited_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    NotFound { pid: u32 },
    /// We chose not to try: pid 0 or 1, our own process, or a process we may not signal.
    #[serde(rename_all = "camelCase")]
    Refused { pid: u32, reason: String },
    #[serde(rename_all = "camelCase")]
    Failed { pid: u32, error: String },
}

/// One link of a process's ancestry, launchd first, the process itself last.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNode {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    PortFreed,
    ForceKilled,
    ZombieReaped,
    CollisionResolved,
    Relaunched,
    Refused,
    Failed,
}

/// What happened, for the Taskline. Recorded by the core, so the tray's kills show up too.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TasklineEvent {
    pub id: u64,
    /// Unix milliseconds.
    pub at_ms: u64,
    pub kind: EventKind,
    pub port: u16,
    pub protocol: Protocol,
    pub pid: u32,
    pub process_name: String,
    pub project: Option<String>,
    /// Memory the process held when it was killed (what the kill gave back).
    pub memory_bytes: u64,
    /// How long the kill took, signal to exit.
    pub duration_ms: u64,
    /// One sentence for the feed.
    pub message: String,
    /// The core remembers the command and cwd, so "Relaunch" can bring it back.
    pub relaunchable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RelaunchOutcome {
    #[serde(rename_all = "camelCase")]
    Started { pid: u32 },
    #[serde(rename_all = "camelCase")]
    NotFound { event_id: u64 },
    #[serde(rename_all = "camelCase")]
    Failed { event_id: u64, error: String },
}

/// The user's preferences (WP-17). Stored in `settings.json`, applied live by `settings`,
/// announced as `settings:changed`. Every field has a default, so a store written by an older
/// release loads without it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// `Show`: a regular app with a Dock icon. `Hide`: menu bar only.
    pub dock_icon: DockIcon,
    pub start_at_login: bool,
    /// The Quick window's global shortcut, in the global-shortcut plugin's syntax.
    pub quick_shortcut: String,
    /// The main window's global shortcut.
    pub window_shortcut: String,
    /// How often the UI and the tray re-read the ports: 1 000–30 000 ms.
    pub refresh_ms: u32,
    /// Kill sends SIGKILL at once; ⌥ flips it either way.
    pub default_force: bool,
    /// macOS notifications for tray kills and watched ports.
    pub notifications: bool,
    /// The first-run card was dismissed.
    pub onboarding_done: bool,
    /// Ports left out of every list, count and bulk kill (AirPlay Receiver holds 5000 and 7000):
    /// sorted, distinct, never 0, at most `crate::hidden::MAX_HIDDEN`.
    pub hidden_ports: Vec<u16>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            dock_icon: DockIcon::Show,
            start_at_login: true,
            quick_shortcut: "CmdOrCtrl+Shift+K".into(),
            window_shortcut: "CmdOrCtrl+Shift+P".into(),
            refresh_ms: 2000,
            default_force: false,
            notifications: true,
            onboarding_done: false,
            hidden_ports: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DockIcon {
    Show,
    Hide,
}

/// A port the user watches (WP-18): the core notifies when its state changes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchedPort {
    pub port: u16,
    pub protocol: Protocol,
    pub state: WatchState,
    /// The process holding the port while `Listening`; the last holder while `Free`, if known.
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    pub project: Option<String>,
    /// Unix milliseconds: when the current state began (the watch's creation until the first change).
    pub since_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WatchState {
    Listening,
    Free,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_and_watches_serialise_as_the_ui_expects() {
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["dockIcon"], "show");
        assert_eq!(json["quickShortcut"], "CmdOrCtrl+Shift+K");
        assert_eq!(json["refreshMs"], 2000);
        assert_eq!(json["onboardingDone"], false);
        assert_eq!(json["hiddenPorts"], serde_json::json!([]));
        // A store from 0.2.x has none of these keys: every missing field falls back to its default.
        let partial: Settings = serde_json::from_value(serde_json::json!({ "refreshMs": 5000 })).unwrap();
        assert_eq!(partial.refresh_ms, 5000);
        assert_eq!(partial.dock_icon, DockIcon::Show);
        assert_eq!(partial.quick_shortcut, "CmdOrCtrl+Shift+K");
        assert!(partial.hidden_ports.is_empty());
        // The contract reads the list as stored; `settings::merge_defaults` sorts it.
        let hiding: Settings = serde_json::from_value(serde_json::json!({ "hiddenPorts": [7000, 5000] })).unwrap();
        assert_eq!(hiding.hidden_ports, [7000, 5000]);
        assert_eq!(hiding.refresh_ms, 2000);

        let watch = WatchedPort {
            port: 3000,
            protocol: Protocol::Tcp,
            state: WatchState::Free,
            pid: Some(48213),
            process_name: Some("node".into()),
            project: None,
            since_ms: 1_700_000_000_123,
        };
        let json = serde_json::to_value(&watch).unwrap();
        assert_eq!(json["state"], "free");
        assert_eq!(json["processName"], "node");
        assert_eq!(json["sinceMs"], 1_700_000_000_123u64);
        let back: WatchedPort = serde_json::from_value(json).unwrap();
        assert_eq!(back, watch);
    }

    #[test]
    fn port_entry_serialises_as_the_ui_expects() {
        let entry = PortEntry {
            port: 3000,
            protocol: Protocol::Tcp,
            bind: BindScope::Loopback,
            address: "127.0.0.1".into(),
            pid: 4242,
            process_name: "node".into(),
            command: "node server.js".into(),
            cwd: Some("/Users/amit/work/shop-api".into()),
            exe: None,
            user: Some("amit".into()),
            memory_bytes: 1024,
            started_at: Some(1_700_000_000),
            parent_pid: Some(1),
            orphan: true,
            project: Some(ProjectInfo {
                name: "shop-api".into(),
                root: "/Users/amit/work/shop-api".into(),
                kind: ProjectKind::Node,
                branch: Some("feature/cart".into()),
                tool: Some("node".into()),
            }),
            protected: false,
            category: Category::Web,
            framework: Some("Next.js".into()),
            container: None,
            launchd: None,
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["processName"], "node");
        assert_eq!(json["protocol"], "tcp");
        assert_eq!(json["bind"], "loopback");
        assert_eq!(json["project"]["kind"], "node");
        assert_eq!(json["memoryBytes"], 1024);
        assert_eq!(json["category"], "web");
        assert_eq!(json["framework"], "Next.js");
        assert_eq!(json["container"], serde_json::Value::Null);
        assert_eq!(json["launchd"], serde_json::Value::Null);
        let back: PortEntry = serde_json::from_value(json).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn launchd_job_serialises_as_the_ui_expects() {
        let job = LaunchdJob {
            label: "homebrew.mxcl.ollama".into(),
            restarts: Some(true),
            brew: Some("ollama".into()),
            stop_command: Some("brew services stop ollama".into()),
            system: false,
        };
        let json = serde_json::to_value(&job).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "label": "homebrew.mxcl.ollama",
                "restarts": true,
                "brew": "ollama",
                "stopCommand": "brew services stop ollama",
                "system": false
            })
        );
        let back: LaunchdJob = serde_json::from_value(json).unwrap();
        assert_eq!(back, job);

        // Unknown is null, not false: the UI words the two apart.
        let unknown = LaunchdJob {
            label: "com.example.agent".into(),
            restarts: None,
            brew: None,
            stop_command: None,
            system: false,
        };
        let json = serde_json::to_value(&unknown).unwrap();
        assert_eq!(json["restarts"], serde_json::Value::Null);
        assert_eq!(json["stopCommand"], serde_json::Value::Null);

        // A piece of macOS: `system`, a plain boolean.
        let apple = LaunchdJob {
            label: "com.apple.controlcenter".into(),
            restarts: None,
            brew: None,
            stop_command: None,
            system: true,
        };
        let json = serde_json::to_value(&apple).unwrap();
        assert_eq!(json["system"], true);
        let back: LaunchdJob = serde_json::from_value(json).unwrap();
        assert_eq!(back, apple);

        // On an entry it sits under `launchd`, camelCase inside.
        let entry = PortEntry {
            port: 11434,
            protocol: Protocol::Tcp,
            bind: BindScope::Loopback,
            address: "127.0.0.1".into(),
            pid: 32014,
            process_name: "ollama".into(),
            command: "/opt/homebrew/opt/ollama/bin/ollama serve".into(),
            cwd: None,
            exe: Some("/opt/homebrew/Cellar/ollama/0.13.0/bin/ollama".into()),
            user: Some("amit".into()),
            memory_bytes: 0,
            started_at: None,
            parent_pid: Some(1),
            orphan: false,
            project: None,
            protected: true,
            category: Category::Ai,
            framework: Some("Ollama".into()),
            container: None,
            launchd: Some(job),
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["launchd"]["stopCommand"], "brew services stop ollama");
        assert_eq!(json["launchd"]["restarts"], true);
        assert_eq!(json["launchd"]["system"], false);
        let back: PortEntry = serde_json::from_value(json).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn categories_and_event_kinds_use_the_ui_spelling() {
        let categories = [Category::Web, Category::Api, Category::Db, Category::Ai, Category::System, Category::Other];
        let spelled: Vec<_> = categories.iter().map(|c| serde_json::to_value(c).unwrap()).collect();
        assert_eq!(spelled, ["web", "api", "db", "ai", "system", "other"]);

        let kinds = [
            EventKind::PortFreed,
            EventKind::ForceKilled,
            EventKind::ZombieReaped,
            EventKind::CollisionResolved,
            EventKind::Relaunched,
            EventKind::Refused,
            EventKind::Failed,
        ];
        let spelled: Vec<_> = kinds.iter().map(|k| serde_json::to_value(k).unwrap()).collect();
        assert_eq!(
            spelled,
            ["portFreed", "forceKilled", "zombieReaped", "collisionResolved", "relaunched", "refused", "failed"]
        );
    }

    #[test]
    fn taskline_event_and_relaunch_outcome_serialise_as_the_ui_expects() {
        let event = TasklineEvent {
            id: 3,
            at_ms: 1_700_000_000_123,
            kind: EventKind::PortFreed,
            port: 3000,
            protocol: Protocol::Tcp,
            pid: 48213,
            process_name: "node".into(),
            project: Some("shop-api".into()),
            memory_bytes: 412 * 1024 * 1024,
            duration_ms: 180,
            message: "Killed node (48213). Port 3000 is free.".into(),
            relaunchable: true,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["atMs"], 1_700_000_000_123u64);
        assert_eq!(json["kind"], "portFreed");
        assert_eq!(json["processName"], "node");
        assert_eq!(json["memoryBytes"], 412 * 1024 * 1024);
        assert_eq!(json["durationMs"], 180);
        assert_eq!(json["relaunchable"], true);
        let back: TasklineEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back, event);

        let json = serde_json::to_value(ProcessNode { pid: 1, name: "launchd".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "pid": 1, "name": "launchd" }));

        let json = serde_json::to_value(RelaunchOutcome::Started { pid: 60001 }).unwrap();
        assert_eq!(json, serde_json::json!({ "status": "started", "pid": 60001 }));
        let json = serde_json::to_value(RelaunchOutcome::NotFound { event_id: 9 }).unwrap();
        assert_eq!(json, serde_json::json!({ "status": "notFound", "eventId": 9 }));
        let json = serde_json::to_value(RelaunchOutcome::Failed { event_id: 9, error: "gone".into() }).unwrap();
        assert_eq!(json["status"], "failed");
        assert_eq!(json["eventId"], 9);
    }

    #[test]
    fn kill_outcome_is_tagged_by_status() {
        let json = serde_json::to_value(KillOutcome::Killed { pid: 7, graceful: true, waited_ms: 120 }).unwrap();
        assert_eq!(json["status"], "killed");
        assert_eq!(json["waitedMs"], 120);
        let json = serde_json::to_value(KillOutcome::Refused { pid: 1, reason: "launchd".into() }).unwrap();
        assert_eq!(json["status"], "refused");
    }
}
