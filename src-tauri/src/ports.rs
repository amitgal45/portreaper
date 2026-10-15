//! Listing: which process listens on which port, enriched with process and project details.
//!
//! Owned by WP-1. The contract this module must keep:
//! - one entry per (pid, port, protocol); an IPv4 and an IPv6 socket of the same process on the
//!   same port are one entry, with `bind` describing the widest reach;
//! - sorted by port, then pid;
//! - never panics on a process that vanished between the socket scan and the process lookup;
//! - fills `project` through `crate::project::detect`.
//!
//! Sockets come from `listeners` (libproc, no `lsof`: that costs ~200 ms a call and its output is
//! not a contract). Process details come from `sysinfo`, refreshed for the listening pids only,
//! so a poll is a handful of syscalls rather than a walk of the whole process table.
//!
//! WP-10 adds the taxonomy (`crate::classify`, per entry, since the port is part of the
//! evidence), `protected` widened to every `Db` and `System` entry, the process's argv kept
//! apart from the joined command (relaunch needs the arguments as they were), and [`tree`].

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;
use std::sync::OnceLock;

use listeners::{Listener, SocketState};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, Uid, UpdateKind, Users};
use thiserror::Error;

use crate::model::{BindScope, Category, PortEntry, ProcessNode, ProjectInfo, Protocol};

/// Executables under these roots belong to macOS, not to the user: never an orphan, always protected.
pub const SYSTEM_PREFIXES: &[&str] =
    &["/System", "/usr/libexec", "/usr/sbin", "/usr/bin", "/Library/Apple", "/sbin"];

/// Processes that hold data or other processes' lifelines: killing one asks twice in the UI.
/// Matched against the lowercased process name and executable file name. WP-6 extends this list.
pub const PROTECTED_NAMES: &[&str] = &[
    "postgres",
    "postgresql",
    "mysqld",
    "mariadbd",
    "mongod",
    "redis-server",
    "com.docker.backend",
    "docker",
    "dockerd",
    "containerd",
    "colima",
    "limactl",
    "orbstack",
    "controlcenter",
    "rapportd",
    "sharingd",
    "mdnsresponder",
    "launchd",
    "sshd",
    "cupsd",
];

/// How many parents [`tree`] follows at most. A real chain on macOS is under ten links; a longer
/// one is a loop in what sysinfo reported, and the walk must end either way.
const MAX_TREE_HOPS: usize = 16;

#[derive(Debug, Error)]
pub enum PortsError {
    #[error("could not read listening sockets: {0}")]
    Listeners(String),
}

/// What one scan found: the entries the UI shows, plus what the core keeps for itself.
pub(crate) struct Listing {
    pub entries: Vec<PortEntry>,
    /// Each pid's command line as separate arguments, for the pids sysinfo could read. The
    /// contract carries only the joined `command`; relaunch needs the arguments as they were.
    pub argv: HashMap<u32, Vec<String>>,
}

/// Every listening socket on this machine with the process behind it.
pub fn list() -> Result<Vec<PortEntry>, PortsError> {
    listing().map(|l| l.entries)
}

/// [`list`] with the argv kept: what the kill paths take, so the Taskline can remember how to
/// relaunch what they killed.
pub(crate) fn listing() -> Result<Listing, PortsError> {
    let raw = listeners::get_all().map_err(|e| PortsError::Listeners(e.to_string()))?;
    let sockets = merge_sockets(raw);

    let mut pids: Vec<Pid> = sockets.iter().map(|s| Pid::from_u32(s.pid)).collect();
    pids.sort_unstable();
    pids.dedup();
    // A fresh `System` knows nothing; the targeted refresh fills in only the pids we are about to
    // show. Caching it across polls would save little and risk showing a pid's previous owner.
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, details_refresh());

    let users = users();
    let current_user = user_name(users, unsafe { libc::getuid() });

    let mut details: HashMap<u32, ProcessDetails> = HashMap::new();
    let entries = sockets
        .into_iter()
        .map(|socket| {
            let d = details
                .entry(socket.pid)
                .or_insert_with(|| ProcessDetails::gather(&socket, &system, users, current_user));
            // The port is part of the evidence, so the category is decided per socket, not per pid.
            let tool = d.project.as_ref().and_then(|p| p.tool.as_deref());
            let (category, framework) =
                crate::classify::classify(socket.port, socket.protocol, tool, &d.name, d.exe.as_deref(), &d.command);
            PortEntry {
                port: socket.port,
                protocol: socket.protocol,
                bind: socket.bind,
                address: socket.address,
                pid: socket.pid,
                process_name: d.name.clone(),
                command: d.command.clone(),
                cwd: d.cwd.clone(),
                exe: d.exe.clone(),
                user: d.user.clone(),
                memory_bytes: d.memory_bytes,
                started_at: d.started_at,
                parent_pid: d.parent_pid,
                orphan: d.orphan,
                project: d.project.clone(),
                // A database or a piece of macOS asks twice whatever WP-1's rule said about it.
                protected: d.protected || matches!(category, Category::Db | Category::System),
                category,
                framework,
                container: None,
            }
        })
        .collect();
    let argv = details.into_iter().filter(|(_, d)| !d.argv.is_empty()).map(|(pid, d)| (pid, d.argv)).collect();
    Ok(Listing { entries, argv })
}

/// The ancestry of `pid`, launchd (pid 1) first and `pid` itself last, through sysinfo's parent
/// links. A pid sysinfo cannot see yields `[pid]` with the name the socket scan has for it, and
/// a pid nothing knows yields `[]`. A chain that breaks before pid 1 (an ancestor we may not
/// read) ends where it broke: the tree says what is known, never what is guessed.
pub(crate) fn tree(pid: u32) -> Vec<ProcessNode> {
    let mut system = System::new();
    // Collected child-first and reversed at the end.
    let mut nodes: Vec<ProcessNode> = Vec::new();
    let mut current = pid;
    while nodes.len() < MAX_TREE_HOPS {
        let id = Pid::from_u32(current);
        // Name and parent come with the cheapest refresh; nothing else is needed per link.
        system.refresh_processes_specifics(ProcessesToUpdate::Some(&[id]), true, ProcessRefreshKind::nothing());
        let Some(process) = system.process(id) else {
            // Pid 1 is launchd by definition, even when its details are not ours to read.
            if current == 1 && !nodes.is_empty() {
                nodes.push(ProcessNode { pid: 1, name: init_name().to_string() });
            }
            break;
        };
        nodes.push(ProcessNode { pid: current, name: process.name().to_string_lossy().into_owned() });
        match process.parent().map(|p| p.as_u32()) {
            // The kernel (pid 0) is nobody's ancestor worth showing; a self-parent would loop.
            Some(parent) if current > 1 && parent != 0 && parent != current => current = parent,
            _ => break,
        }
    }
    if nodes.is_empty() {
        if let Some(name) = socket_name(pid) {
            nodes.push(ProcessNode { pid, name });
        }
    }
    nodes.reverse();
    nodes
}

/// What pid 1 is called when sysinfo cannot say.
fn init_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "launchd"
    } else {
        "init"
    }
}

/// The name the socket scan has for `pid`, when it holds a port: libproc names a process whose
/// details sysinfo may not read.
fn socket_name(pid: u32) -> Option<String> {
    let raw = listeners::get_all().ok()?;
    merge_sockets(raw).into_iter().find(|s| s.pid == pid).map(|s| s.process_name)
}

/// One socket after the IPv4/IPv6 twins are folded: what `list()` still needs from `listeners`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Socket {
    pub pid: u32,
    pub port: u16,
    pub protocol: Protocol,
    pub bind: BindScope,
    pub address: String,
    pub process_name: String,
    pub path: String,
}

/// Keeps the sockets that hold a port and folds twins into one `Socket` per (pid, port, protocol),
/// sorted by port then pid. `bind` is the widest reach among the twins and `address` belongs to
/// that widest socket.
pub(crate) fn merge_sockets(raw: impl IntoIterator<Item = Listener>) -> Vec<Socket> {
    let mut held: Vec<Listener> = raw.into_iter().filter(holds_a_port).collect();
    // `get_all` hands back a set, so impose an order before folding: the address an entry shows
    // must not depend on hash seeds, and IPv4 first means `0.0.0.0` wins a tie with `::`.
    held.sort_by_key(|l| (l.process.pid, l.socket.port(), l.protocol == listeners::Protocol::UDP, l.socket.ip()));

    let mut merged: Vec<Socket> = Vec::new();
    for l in held {
        let protocol = match l.protocol {
            listeners::Protocol::TCP => Protocol::Tcp,
            listeners::Protocol::UDP => Protocol::Udp,
        };
        let address = l.socket.ip().to_string();
        let bind = classify_bind(&address);
        match merged.last_mut() {
            Some(prev) if prev.pid == l.process.pid && prev.port == l.socket.port() && prev.protocol == protocol => {
                if reach(bind) > reach(prev.bind) {
                    prev.bind = bind;
                    prev.address = address;
                }
            }
            _ => merged.push(Socket {
                pid: l.process.pid,
                port: l.socket.port(),
                protocol,
                bind,
                address,
                process_name: l.process.name,
                path: l.process.path,
            }),
        }
    }
    merged.sort_by_key(|s| (s.port, s.pid));
    merged
}

/// A TCP socket holds a port only while it listens; ESTABLISHED and friends are a connection, not
/// a port. Port 0 is a socket that was never bound: there is nothing to free.
fn holds_a_port(l: &Listener) -> bool {
    l.socket.port() != 0
        && match l.protocol {
            listeners::Protocol::TCP => l.state == SocketState::Listen,
            listeners::Protocol::UDP => true,
        }
}

fn reach(bind: BindScope) -> u8 {
    match bind {
        BindScope::Loopback => 0,
        BindScope::Other => 1,
        BindScope::Any => 2,
    }
}

/// Who can reach a socket bound to `address`. `*` is how some tools spell "every interface".
pub fn classify_bind(address: &str) -> BindScope {
    if address == "*" {
        return BindScope::Any;
    }
    let Ok(ip) = address.parse::<IpAddr>() else {
        return BindScope::Other;
    };
    // An IPv6 socket bound to an IPv4-mapped address (`::ffff:127.0.0.1`) reaches exactly what
    // the IPv4 address does.
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    };
    if ip.is_unspecified() {
        BindScope::Any
    } else if ip.is_loopback() {
        BindScope::Loopback
    } else {
        BindScope::Other
    }
}

/// A process whose parent died is re-parented to launchd (pid 1). That is the signature of a dev
/// server whose terminal closed, but also of every daemon launchd starts on purpose; owner and the
/// executable's location tell them apart.
pub fn is_orphan(parent_pid: Option<u32>, exe: Option<&str>, user: Option<&str>, current_user: Option<&str>) -> bool {
    let reparented = matches!(parent_pid, None | Some(1));
    let mine = user.is_some() && user == current_user;
    reparented && mine && !exe.is_some_and(is_system_path)
}

/// Whether killing this process deserves a second confirmation. An unknown owner counts as
/// another user: when we cannot tell whose it is, the safe answer is "ask".
pub fn is_protected(process_name: &str, exe: Option<&str>, user: Option<&str>, current_user: Option<&str>) -> bool {
    if user.is_none() || user != current_user {
        return true;
    }
    if exe.is_some_and(is_system_path) {
        return true;
    }
    let name = process_name.to_lowercase();
    let file_name = exe.and_then(|e| Path::new(e).file_name()).map(|f| f.to_string_lossy().to_lowercase());
    PROTECTED_NAMES.iter().any(|p| *p == name || file_name.as_deref() == Some(*p))
}

fn is_system_path(exe: &str) -> bool {
    SYSTEM_PREFIXES.iter().any(|prefix| Path::new(exe).starts_with(prefix))
}

/// Everything about one process that is the same for all of its sockets.
#[derive(Clone)]
struct ProcessDetails {
    name: String,
    /// The command line as the kernel has it, one string per argument. Empty when sysinfo could
    /// not read it (another user's process).
    argv: Vec<String>,
    /// `argv` joined with spaces: what the contract shows.
    command: String,
    cwd: Option<String>,
    exe: Option<String>,
    user: Option<String>,
    memory_bytes: u64,
    started_at: Option<u64>,
    parent_pid: Option<u32>,
    orphan: bool,
    protected: bool,
    project: Option<ProjectInfo>,
}

impl ProcessDetails {
    /// Reads what sysinfo managed to collect. A pid that vanished since the socket scan, or one
    /// we may not inspect, yields empty details rather than an error: the socket is still real.
    fn gather(socket: &Socket, system: &System, users: &Users, current_user: Option<&str>) -> Self {
        let process = system.process(Pid::from_u32(socket.pid));
        // `listeners` already named the process; sysinfo is the fallback for the rare empty name.
        let name = if socket.process_name.is_empty() {
            process.map(|p| p.name().to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            socket.process_name.clone()
        };
        let argv: Vec<String> =
            process.map(|p| p.cmd().iter().map(|arg| arg.to_string_lossy().into_owned()).collect()).unwrap_or_default();
        let command = argv.join(" ");
        let cwd = process.and_then(|p| p.cwd()).map(path_string);
        let exe = process
            .and_then(|p| p.exe())
            .map(path_string)
            .or_else(|| (!socket.path.is_empty()).then(|| socket.path.clone()));
        let user = process
            .and_then(|p| p.user_id())
            .and_then(|uid| users.get_user_by_id(uid))
            .map(|u| u.name().to_string());
        let memory_bytes = process.map_or(0, |p| p.memory());
        let started_at = process.map(|p| p.start_time()).filter(|&t| t > 0);
        let parent_pid = process.and_then(|p| p.parent()).map(|p| p.as_u32());
        let project = crate::project::detect(cwd.as_deref().map(Path::new), exe.as_deref().map(Path::new), &command);
        let orphan = is_orphan(parent_pid, exe.as_deref(), user.as_deref(), current_user);
        let protected = is_protected(&name, exe.as_deref(), user.as_deref(), current_user);
        Self { name, argv, command, cwd, exe, user, memory_bytes, started_at, parent_pid, orphan, protected, project }
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Only what the entry shows. Environment and CPU would cost syscalls per pid for nothing.
fn details_refresh() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cmd(UpdateKind::Always)
        .with_cwd(UpdateKind::Always)
        .with_exe(UpdateKind::Always)
        .with_user(UpdateKind::Always)
        .with_memory()
}

/// The user table costs ~20 ms through OpenDirectory, so it is read once per process. Accounts do
/// not come and go while the app runs, and a uid it does not know degrades to `user: None`,
/// which `is_protected` treats as "ask".
fn users() -> &'static Users {
    static USERS: OnceLock<Users> = OnceLock::new();
    USERS.get_or_init(Users::new_with_refreshed_list)
}

fn user_name(users: &Users, uid: libc::uid_t) -> Option<&str> {
    let uid = Uid::try_from(uid as usize).ok()?;
    users.get_user_by_id(&uid).map(|u| u.name())
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::time::Instant;

    use listeners::{Listener, Process, Protocol as Proto, SocketState};

    use super::*;

    fn socket(pid: u32, addr: &str, protocol: Proto, state: SocketState) -> Listener {
        Listener {
            process: Process { pid, name: "node".into(), path: "/usr/local/bin/node".into() },
            socket: addr.parse().unwrap(),
            protocol,
            state,
        }
    }

    fn listening(pid: u32, addr: &str) -> Listener {
        socket(pid, addr, Proto::TCP, SocketState::Listen)
    }

    #[test]
    fn merge_folds_ipv4_and_ipv6_twins_into_one_entry_with_the_widest_bind() {
        let merged = merge_sockets([listening(10, "127.0.0.1:3000"), listening(10, "[::]:3000")]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].bind, BindScope::Any);
        assert_eq!(merged[0].address, "::");

        let merged = merge_sockets([listening(10, "[::1]:3000"), listening(10, "127.0.0.1:3000")]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].bind, BindScope::Loopback);
        assert_eq!(merged[0].address, "127.0.0.1", "IPv4 wins a tie, whatever order the set yields");

        let merged = merge_sockets([listening(10, "[::]:3000"), listening(10, "0.0.0.0:3000")]);
        assert_eq!(merged[0].address, "0.0.0.0");
    }

    #[test]
    fn merge_keeps_protocols_and_pids_apart() {
        let merged = merge_sockets([
            listening(10, "0.0.0.0:5353"),
            socket(10, "0.0.0.0:5353", Proto::UDP, SocketState::Unknown),
            listening(11, "0.0.0.0:5353"),
        ]);
        assert_eq!(merged.len(), 3);
        let keys: Vec<_> = merged.iter().map(|s| (s.pid, s.port, s.protocol)).collect();
        assert_eq!(keys, [(10, 5353, Protocol::Tcp), (10, 5353, Protocol::Udp), (11, 5353, Protocol::Tcp)]);
    }

    #[test]
    fn merge_sorts_by_port_then_pid() {
        let merged = merge_sockets([
            listening(30, "127.0.0.1:8080"),
            listening(20, "127.0.0.1:3000"),
            listening(10, "127.0.0.1:8080"),
        ]);
        let keys: Vec<_> = merged.iter().map(|s| (s.port, s.pid)).collect();
        assert_eq!(keys, [(3000, 20), (8080, 10), (8080, 30)]);
    }

    #[test]
    fn merge_drops_connections_and_unbound_sockets() {
        let merged = merge_sockets([
            socket(10, "192.168.1.5:49152", Proto::TCP, SocketState::Established),
            socket(10, "127.0.0.1:3000", Proto::TCP, SocketState::CloseWait),
            socket(11, "0.0.0.0:0", Proto::UDP, SocketState::Unknown),
            socket(12, "0.0.0.0:5353", Proto::UDP, SocketState::Unknown),
        ]);
        let keys: Vec<_> = merged.iter().map(|s| (s.pid, s.port, s.protocol)).collect();
        assert_eq!(keys, [(12, 5353, Protocol::Udp)]);
    }

    #[test]
    fn classify_bind_table() {
        assert_eq!(classify_bind("127.0.0.1"), BindScope::Loopback);
        assert_eq!(classify_bind("127.0.0.53"), BindScope::Loopback);
        assert_eq!(classify_bind("::1"), BindScope::Loopback);
        assert_eq!(classify_bind("::ffff:127.0.0.1"), BindScope::Loopback);
        assert_eq!(classify_bind("0.0.0.0"), BindScope::Any);
        assert_eq!(classify_bind("::"), BindScope::Any);
        assert_eq!(classify_bind("*"), BindScope::Any);
        assert_eq!(classify_bind("192.168.1.5"), BindScope::Other);
        assert_eq!(classify_bind("fe80::1"), BindScope::Other);
        assert_eq!(classify_bind("not an address"), BindScope::Other);
    }

    #[test]
    fn orphan_table() {
        let me = Some("amit");
        // a dev server whose terminal died
        assert!(is_orphan(Some(1), Some("/opt/homebrew/bin/node"), me, me));
        assert!(is_orphan(None, Some("/Users/amit/work/api/target/debug/api"), me, me));
        // rapportd: launchd's child by design, system path
        assert!(!is_orphan(Some(1), Some("/usr/libexec/rapportd"), Some("amit"), me));
        // a stray process of another user is not ours to flag
        assert!(!is_orphan(Some(1), Some("/opt/homebrew/bin/node"), Some("root"), me));
        assert!(!is_orphan(Some(1), Some("/opt/homebrew/bin/node"), None, me));
        // still has a living parent
        assert!(!is_orphan(Some(4242), Some("/opt/homebrew/bin/node"), me, me));
        // no exe known: nothing says it is a system process
        assert!(is_orphan(Some(1), None, me, me));
    }

    #[test]
    fn protected_table() {
        let me = Some("amit");
        assert!(!is_protected("node", Some("/opt/homebrew/bin/node"), me, me));
        assert!(is_protected("node", Some("/opt/homebrew/bin/node"), Some("root"), me));
        assert!(is_protected("node", Some("/opt/homebrew/bin/node"), None, me));
        assert!(is_protected("rapportd", Some("/usr/libexec/rapportd"), me, me));
        assert!(is_protected("sshd", Some("/usr/sbin/sshd"), me, me));
        // by name, wherever it lives
        assert!(is_protected("postgres", Some("/opt/homebrew/opt/postgresql@16/bin/postgres"), me, me));
        assert!(is_protected("Postgres", None, me, me));
        // by executable file name when the process name is unhelpful
        assert!(is_protected("", Some("/Applications/Docker.app/Contents/MacOS/com.docker.backend"), me, me));
        // a prefix match is not a match: `/usr/binx` is not `/usr/bin`
        assert!(!is_protected("node", Some("/usr/binx/node"), me, me));
        // a user-space look-alike name is still protected: better to ask twice than kill a database
        assert!(is_protected("redis-server", Some("/Users/amit/.local/bin/redis-server"), me, me));
    }

    #[test]
    fn list_sees_our_own_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let pid = std::process::id();

        // The first call pays for the user table once; the second is what every poll costs.
        let started = Instant::now();
        let entries = list().unwrap();
        let cold = started.elapsed();
        let started = Instant::now();
        let entries_again = list().unwrap();
        let warm = started.elapsed();
        println!("list() took {cold:?} cold, {warm:?} warm, for {} entries", entries.len());
        assert!(cold.as_millis() < 1000, "list() took {cold:?}");
        assert!(warm.as_millis() < 1000, "list() took {warm:?}");
        assert!(!entries_again.is_empty());

        let ours: Vec<_> = entries.iter().filter(|e| e.port == port && e.pid == pid).collect();
        assert_eq!(ours.len(), 1, "expected exactly our listener on port {port}: {ours:?}");
        let entry = ours[0];
        assert_eq!(entry.bind, BindScope::Loopback);
        assert_eq!(entry.address, "127.0.0.1");
        assert_eq!(entry.protocol, Protocol::Tcp);
        assert!(entry.cwd.is_some(), "cwd should be known for our own process");
        assert!(!entry.command.is_empty(), "command should be known for our own process");
        assert!(!entry.process_name.is_empty());
        assert!(entry.exe.is_some());
        assert!(entry.user.is_some(), "our own user must resolve");
        assert!(entry.started_at.is_some());
        assert!(entry.parent_pid.is_some());
        assert!(!entry.protected, "our own test binary is nothing special");
        assert!(!entry.orphan, "cargo is still our parent");
        assert!(entry.memory_bytes > 0);
        assert_eq!((entry.category, entry.framework.as_deref()), (Category::Other, None), "a test binary on a random port is nothing we can name");
    }

    #[test]
    fn listing_keeps_our_argv_apart_from_the_joined_command() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let pid = std::process::id();

        let listing = listing().unwrap();
        let entry = listing.entries.iter().find(|e| e.port == port && e.pid == pid).expect("our listener");
        let argv = listing.argv.get(&pid).expect("our own argv is readable");
        assert!(!argv.is_empty());
        assert_eq!(argv.join(" "), entry.command, "the command is the argv joined, nothing more");
        assert!(argv[0].contains("portreaper"), "argv[0] is the test binary: {argv:?}");
    }

    #[test]
    fn tree_of_this_process_starts_at_pid_1_and_ends_here() {
        let me = std::process::id();
        let tree = tree(me);
        println!("tree: {tree:?}");
        assert!(tree.len() >= 2, "at least launchd and us: {tree:?}");
        assert_eq!(tree.last().map(|n| n.pid), Some(me));
        assert_eq!(tree.first().map(|n| n.pid), Some(1), "launchd first: {tree:?}");
        assert_eq!(tree.first().map(|n| n.name.as_str()), Some("launchd"));
        assert!(tree.iter().all(|n| !n.name.is_empty()), "every link is named: {tree:?}");
        // The parent sysinfo reports is the link before us.
        let parent = tree[tree.len() - 2].pid;
        let entries = list().unwrap();
        if let Some(entry) = entries.iter().find(|e| e.pid == me) {
            assert_eq!(entry.parent_pid, Some(parent));
        }
    }

    #[test]
    fn tree_of_a_pid_nobody_knows_is_empty() {
        // macOS pids stop at 99998; this number is never a process.
        assert!(tree(99_999).is_empty());
    }

    #[test]
    fn list_merges_our_v4_and_v6_listeners_on_one_port() {
        let (v4, v6) = bind_twins();
        let port = v4.local_addr().unwrap().port();
        let pid = std::process::id();

        let entries = list().unwrap();
        let ours: Vec<_> = entries.iter().filter(|e| e.port == port && e.pid == pid).collect();
        assert_eq!(ours.len(), 1, "twins must fold into one entry: {ours:?}");
        assert_eq!(ours[0].bind, BindScope::Loopback);
        drop(v6);
    }

    /// Binds `127.0.0.1:P` and `[::1]:P` for the same `P`. Someone else may hold the IPv6 side of a
    /// port the kernel picked for IPv4, so try a few.
    fn bind_twins() -> (TcpListener, TcpListener) {
        for _ in 0..20 {
            let v4 = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = v4.local_addr().unwrap().port();
            if let Ok(v6) = TcpListener::bind(("::1", port)) {
                return (v4, v6);
            }
        }
        panic!("could not bind an IPv4/IPv6 pair on one port");
    }
}
