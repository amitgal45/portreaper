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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Tcp,
    Udp,
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

#[cfg(test)]
mod tests {
    use super::*;

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
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["processName"], "node");
        assert_eq!(json["protocol"], "tcp");
        assert_eq!(json["bind"], "loopback");
        assert_eq!(json["project"]["kind"], "node");
        assert_eq!(json["memoryBytes"], 1024);
        let back: PortEntry = serde_json::from_value(json).unwrap();
        assert_eq!(back, entry);
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
