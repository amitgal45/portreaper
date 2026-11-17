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
//!
//! WP-20 names the container behind a port Docker's backend holds ([`attach_containers`], from
//! one `crate::docker::containers()` per listing that has a Docker process, cached there).
//!
//! A process launchd runs as a job in the user's domain (`brew services`, any LaunchAgent), or a
//! direct child of one (`launchd::MAX_JOB_HOPS`), carries that job (`launchd`, from one `crate::launchd::running_jobs()` per
//! listing that has a process launchd parents, cached there). Such a process is never an orphan,
//! so a portless one is never listed, and one whose job launchd starts again after a kill
//! (KeepAlive) is protected ([`apply_launchd`]).

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;
use std::sync::OnceLock;

use listeners::{Listener, SocketState};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, Uid, UpdateKind, Users};
use thiserror::Error;

use crate::docker::Container;
use crate::model::{
    BindScope, Category, LaunchdJob, PortEntry, ProcessNode, ProjectInfo, ProjectKind, Protocol,
};

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
    "com.docker.vpnkit",
    "vpnkit",
    "docker-proxy",
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

/// The processes that hold a container's published port on the host: Docker Desktop's backend
/// and its forwarders, and a Linux-style daemon's proxy. A port one of these holds is looked up
/// in `docker ps` (WP-20). Matched like [`PROTECTED_NAMES`]; every one of them is in that list.
pub const DOCKER_NAMES: &[&str] = &["com.docker.backend", "com.docker.vpnkit", "vpnkit", "docker-proxy", "dockerd", "docker"];

/// Explicit agent, MCP, headless browser, test runner, and dev-server tools that can leak as
/// portless (`stdio` or worker) orphans when an IDE, agent session, or terminal exits (WP-23).
pub const ORPHAN_DEV_TOOLS: &[&str] = &[
    "mcp",
    "playwright",
    "puppeteer",
    "vitest",
    "jest",
    "esbuild",
    "rust-analyzer",
    "vite",
    "next",
    "nuxt",
    "nest",
    "remix",
    "astro",
    "storybook",
    "webpack",
    "tsx",
    "ts-node",
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

    let mut socket_pids: Vec<Pid> = sockets.iter().map(|s| Pid::from_u32(s.pid)).collect();
    socket_pids.sort_unstable();
    socket_pids.dedup();

    // A fresh `System` knows nothing. First do a cheap pass (parent + uid only) to spot candidate
    // orphans (parent == 1, owned by current user, not holding a listening socket), then refresh
    // full details (`cmd`, `cwd`, `exe`, `memory`) only for socket holders and orphan candidates.
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_user(UpdateKind::Always),
    );

    let raw_uid = unsafe { libc::getuid() };
    let current_uid = Uid::try_from(raw_uid as usize).ok();
    let mut orphan_pids: Vec<Pid> = system
        .processes()
        .iter()
        .filter(|(&pid, proc)| {
            let p = pid.as_u32();
            p > 1
                && matches!(proc.parent().map(|pp| pp.as_u32()), None | Some(1))
                && proc.user_id() == current_uid.as_ref()
                && socket_pids.binary_search(&pid).is_err()
        })
        .map(|(&pid, _)| pid)
        .collect();
    orphan_pids.sort_unstable_by_key(|p| p.as_u32());

    let mut detail_pids = socket_pids.clone();
    detail_pids.extend_from_slice(&orphan_pids);
    detail_pids.sort_unstable();
    detail_pids.dedup();
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&detail_pids), false, details_refresh());

    let users = users();
    let current_user = user_name(users, raw_uid);

    // launchd parents every job it runs: with no process of ours that it parents, there is no
    // job to ask `launchctl` about. PortReaper itself is never a job it reports, or a process
    // it relaunched would carry its login item's label.
    let launchd_parents_one = !orphan_pids.is_empty()
        || socket_pids.iter().any(|pid| parent_of(&system, pid.as_u32()) == Some(1));
    let mut jobs = if launchd_parents_one { crate::launchd::running_jobs() } else { HashMap::new() };
    jobs.remove(&std::process::id());
    let home = std::env::var_os("HOME");
    let home = home.as_deref().map(Path::new);
    // One description per job and listing: its plist is read once however many sockets it has.
    let mut described: HashMap<String, LaunchdJob> = HashMap::new();
    let mut launchd_of = |pid: u32| -> Option<LaunchdJob> {
        let label = crate::launchd::job_of(pid, &jobs, |p| parent_of(&system, p))?;
        let job = described
            .entry(label.to_string())
            .or_insert_with(|| crate::launchd::describe(label, home, raw_uid));
        Some(job.clone())
    };

    let mut details: HashMap<u32, ProcessDetails> = HashMap::new();
    let mut entries: Vec<PortEntry> = sockets
        .into_iter()
        .map(|socket| {
            let d = details
                .entry(socket.pid)
                .or_insert_with(|| ProcessDetails::gather(&socket, &system, users, current_user));
            // The port is part of the evidence, so the category is decided per socket, not per pid.
            let tool = d.project.as_ref().and_then(|p| p.tool.as_deref());
            let (category, framework) =
                crate::classify::classify(socket.port, socket.protocol, tool, &d.name, d.exe.as_deref(), &d.command);
            let mut entry = PortEntry {
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
                launchd: None,
            };
            apply_launchd(&mut entry, launchd_of(socket.pid));
            entry
        })
        .collect();

    // Append portless (`port: 0`, `address: "stdio"`) orphaned agent/MCP/browser/test processes
    // sorted by pid after the socket entries (WP-23).
    for pid in orphan_pids {
        let p = pid.as_u32();
        // A job is launchd's child on purpose, not a lost one.
        if crate::launchd::job_of(p, &jobs, |pp| parent_of(&system, pp)).is_some() {
            continue;
        }
        let placeholder = Socket {
            pid: p,
            port: 0,
            protocol: Protocol::Tcp,
            bind: BindScope::Loopback,
            address: "stdio".into(),
            process_name: String::new(),
            path: String::new(),
        };
        let d = ProcessDetails::gather(&placeholder, &system, users, current_user);
        if !d.orphan || d.protected || !is_reapable_orphan(&d.name, d.exe.as_deref(), &d.command, d.project.as_ref()) {
            continue;
        }
        let tool = d.project.as_ref().and_then(|proj| proj.tool.as_deref());
        let (category, framework) =
            crate::classify::classify(0, Protocol::Tcp, tool, &d.name, d.exe.as_deref(), &d.command);
        if matches!(category, Category::Db | Category::System) {
            continue;
        }
        entries.push(PortEntry {
            port: 0,
            protocol: Protocol::Tcp,
            bind: BindScope::Loopback,
            address: "stdio".into(),
            pid: p,
            process_name: d.name.clone(),
            command: d.command.clone(),
            cwd: d.cwd.clone(),
            exe: d.exe.clone(),
            user: d.user.clone(),
            memory_bytes: d.memory_bytes,
            started_at: d.started_at,
            parent_pid: d.parent_pid,
            orphan: true,
            project: d.project.clone(),
            protected: false,
            category,
            framework,
            container: None,
            launchd: None,
        });
        details.insert(p, d);
    }

    // One `docker ps` (cached 5 s in `docker`) when Docker holds a port; none at all otherwise.
    if entries.iter().any(|e| is_docker_process(&e.process_name, e.exe.as_deref())) {
        attach_containers(&mut entries, &crate::docker::containers());
    }
    let argv = details.into_iter().filter(|(_, d)| !d.argv.is_empty()).map(|(pid, d)| (pid, d.argv)).collect();
    Ok(Listing { entries, argv })
}

/// Names the container behind every entry a Docker process holds whose `(port, protocol)` a
/// container publishes: `container`, the framework and category from the image
/// (`classify::classify_container`), the image as the entry's project (the port belongs to the
/// container, not to wherever the backend was started), and `protected` kept. Entries of other
/// processes, and Docker's ports no container publishes, are left as they are.
pub(crate) fn attach_containers(entries: &mut [PortEntry], containers: &[Container]) {
    for entry in entries.iter_mut().filter(|e| is_docker_process(&e.process_name, e.exe.as_deref())) {
        let Some(container) = containers.iter().find(|c| c.ports.contains(&(entry.port, entry.protocol))) else {
            continue;
        };
        let (category, framework) = crate::classify::classify_container(entry.port, entry.protocol, &container.image);
        entry.container = Some(container.name.clone());
        entry.category = category;
        entry.framework = Some(framework);
        entry.project = Some(ProjectInfo {
            name: container.image.clone(),
            root: String::new(),
            kind: ProjectKind::Unknown,
            branch: None,
            tool: Some("docker".into()),
        });
        // Kill stops the container, never the backend; it still asks twice.
        entry.protected = true;
    }
}

/// What launchd running a process as a job changes about its entry: it is never an orphan
/// (launchd is its parent on purpose), and one that launchd starts again after a kill
/// (`restarts == Some(true)`) asks first, so no bulk kill reaches it and every single one asks.
/// `None` leaves the entry as it was.
fn apply_launchd(entry: &mut PortEntry, job: Option<LaunchdJob>) {
    let Some(job) = job else {
        return;
    };
    entry.orphan = false;
    if job.restarts == Some(true) {
        entry.protected = true;
    }
    entry.launchd = Some(job);
}

/// The parent sysinfo reports for `pid`, when it knows the pid.
fn parent_of(system: &System, pid: u32) -> Option<u32> {
    system.process(Pid::from_u32(pid)).and_then(|p| p.parent()).map(|p| p.as_u32())
}

/// Whether this is one of the processes that hold a container's port on the host
/// ([`DOCKER_NAMES`]), by its name or its executable's file name.
pub fn is_docker_process(process_name: &str, exe: Option<&str>) -> bool {
    named_any(process_name, exe, DOCKER_NAMES)
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
/// executable's location tell them apart. A macOS GUI app (Spotify, Slack, Ollama.app) is launchd's
/// child too, because LaunchServices starts it; an exe inside a `.app` bundle is never a lost
/// terminal's server.
pub fn is_orphan(parent_pid: Option<u32>, exe: Option<&str>, user: Option<&str>, current_user: Option<&str>) -> bool {
    let reparented = matches!(parent_pid, None | Some(1));
    let mine = user.is_some() && user == current_user;
    reparented && mine && !exe.is_some_and(is_system_path) && !is_app_bundle(exe)
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
    named_any(process_name, exe, PROTECTED_NAMES)
}

/// Whether `exe` lives inside a macOS `.app` bundle (`/Applications/*.app/Contents/...` or
/// `~/Applications/*.app/Contents/...`). GUI app helpers are often re-parented to launchd and must
/// never be flagged as portless agent/dev zombies.
pub fn is_app_bundle(exe: Option<&str>) -> bool {
    exe.is_some_and(|path| path.contains(".app/Contents/"))
}

/// Whether a portless (`port == 0`) process that already passed [`is_orphan`] and [`!is_protected`]
/// is an orphaned agent/MCP/headless-browser/dev-worker process that PortReaper should surface.
pub fn is_reapable_orphan(
    process_name: &str,
    exe: Option<&str>,
    command: &str,
    project: Option<&ProjectInfo>,
) -> bool {
    if is_app_bundle(exe) {
        return false;
    }
    let tool = project
        .and_then(|p| p.tool.as_deref())
        .map(str::to_string)
        .or_else(|| crate::project::detect_tool(command));
    if let Some(t) = tool.as_deref() {
        if ORPHAN_DEV_TOOLS.contains(&t) {
            return true;
        }
    }
    let name = process_name.to_ascii_lowercase();
    ORPHAN_DEV_TOOLS.iter().any(|&t| name == t || name.starts_with(&format!("{t}-")))
}

/// Whether the lowercased process name or the executable's file name is one of `names`.
fn named_any(process_name: &str, exe: Option<&str>, names: &[&str]) -> bool {
    let name = process_name.to_lowercase();
    let file_name = exe.and_then(|e| Path::new(e).file_name()).map(|f| f.to_string_lossy().to_lowercase());
    names.iter().any(|p| *p == name || file_name.as_deref() == Some(*p))
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
        // a GUI app LaunchServices started is launchd's child by design, in /Applications or ~/Applications
        assert!(!is_orphan(Some(1), Some("/Applications/Spotify.app/Contents/MacOS/Spotify"), me, me));
        assert!(!is_orphan(Some(1), Some("/Users/amit/Applications/Ollama.app/Contents/Resources/ollama"), me, me));
    }

    #[test]
    fn reapable_orphan_accepts_mcp_playwright_and_dev_workers_and_rejects_app_bundles_and_shells() {
        let node = Some("/opt/homebrew/bin/node");
        // MCP stdio servers
        assert!(is_reapable_orphan(
            "node",
            node,
            "node /Users/amit/.npm/_npx/123/node_modules/.bin/mcp-server-filesystem /Users/amit/work",
            None
        ));
        assert!(is_reapable_orphan(
            "node",
            node,
            "npx -y @modelcontextprotocol/server-postgres",
            None
        ));
        assert!(is_reapable_orphan(
            "mcp-server-git",
            Some("/Users/amit/.local/bin/mcp-server-git"),
            "",
            None
        ));
        // Headless browser & test runners
        assert!(is_reapable_orphan(
            "chrome-headless-shell",
            Some("/Users/amit/Library/Caches/ms-playwright/chromium_headless_shell-1148/chrome-mac/headless_shell"),
            "headless_shell --headless",
            None
        ));
        assert!(is_reapable_orphan(
            "node (vitest 1)",
            node,
            "node /Users/amit/work/app/node_modules/.bin/vitest",
            None
        ));
        assert!(is_reapable_orphan(
            "esbuild",
            Some("/Users/amit/work/app/node_modules/@esbuild/darwin-arm64/bin/esbuild"),
            "esbuild --service=0.24.0 --ping",
            None
        ));
        assert!(is_reapable_orphan(
            "rust-analyzer",
            Some("/Users/amit/.cargo/bin/rust-analyzer"),
            "rust-analyzer",
            None
        ));
        // Rejects macOS .app bundle helpers even when their command mentions node or mcp
        assert!(!is_reapable_orphan(
            "Cursor Helper (Plugin)",
            Some("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)"),
            "node mcp-server",
            None
        ));
        assert!(is_app_bundle(Some("/Applications/Raycast.app/Contents/MacOS/Raycast")));
        assert!(!is_app_bundle(node));
        // Rejects generic shells, editors, and bare node scripts with no dev/agent tool signature
        assert!(!is_reapable_orphan("zsh", Some("/bin/zsh"), "-zsh", None));
        assert!(!is_reapable_orphan("tmux", Some("/opt/homebrew/bin/tmux"), "tmux new-session", None));
        assert!(!is_reapable_orphan("node", node, "node scripts/backup.js", None));
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
    fn docker_process_table() {
        assert!(is_docker_process("com.docker.backend", Some("/Applications/Docker.app/Contents/MacOS/com.docker.backend")));
        assert!(is_docker_process("", Some("/Applications/Docker.app/Contents/MacOS/com.docker.backend")));
        assert!(is_docker_process("vpnkit", None));
        assert!(is_docker_process("com.docker.vpnkit", None));
        assert!(is_docker_process("docker-proxy", Some("/usr/bin/docker-proxy")));
        assert!(!is_docker_process("postgres", Some("/opt/homebrew/bin/postgres")));
        assert!(!is_docker_process("node", None));
        // Every Docker name is protected too: the kill path's gate stays in force.
        let me = Some("amit");
        for name in DOCKER_NAMES {
            assert!(PROTECTED_NAMES.contains(name), "{name}");
            assert!(is_protected(name, None, me, me), "{name}");
        }
    }

    fn docker_entry(port: u16, protocol: Protocol) -> PortEntry {
        let exe = "/Applications/Docker.app/Contents/MacOS/com.docker.backend";
        let (category, framework) =
            crate::classify::classify(port, protocol, Some("docker"), "com.docker.backend", Some(exe), exe);
        PortEntry {
            port,
            protocol,
            bind: BindScope::Any,
            address: "*".into(),
            pid: 11710,
            process_name: "com.docker.backend".into(),
            command: exe.into(),
            cwd: Some("/".into()),
            exe: Some(exe.into()),
            user: Some("amit".into()),
            memory_bytes: 1 << 30,
            started_at: Some(1_700_000_000),
            parent_pid: Some(1),
            orphan: false,
            project: None,
            protected: true,
            category,
            framework,
            container: None,
            launchd: None,
        }
    }

    fn container(name: &str, image: &str, ports: &[(u16, Protocol)]) -> Container {
        Container { name: name.into(), image: image.into(), ports: ports.to_vec() }
    }

    #[test]
    fn a_docker_port_a_container_publishes_gets_the_container_and_its_image() {
        let mut entries = vec![
            docker_entry(5432, Protocol::Tcp),
            docker_entry(6379, Protocol::Tcp),
            docker_entry(8080, Protocol::Tcp),
            docker_entry(53, Protocol::Udp),
            // The same port held by somebody else is not Docker's business.
            PortEntry { process_name: "node".into(), exe: Some("/opt/homebrew/bin/node".into()), pid: 4242, ..docker_entry(5432, Protocol::Tcp) },
        ];
        let containers = [
            container("shop-db", "postgres:16", &[(5432, Protocol::Tcp)]),
            container("api", "ghcr.io/acme/shop-api:latest", &[(8080, Protocol::Tcp)]),
            container("dns", "coredns/coredns:1.11", &[(53, Protocol::Udp), (53, Protocol::Tcp)]),
            container("idle", "busybox", &[]),
        ];
        attach_containers(&mut entries, &containers);

        let db = &entries[0];
        assert_eq!(db.container.as_deref(), Some("shop-db"));
        assert_eq!((db.category, db.framework.as_deref()), (Category::Db, Some("PostgreSQL")));
        assert_eq!(db.project.as_ref().map(|p| (p.name.as_str(), p.root.as_str(), p.tool.as_deref())), Some(("postgres:16", "", Some("docker"))));
        assert!(db.protected);

        // Docker's port that no container publishes: as before.
        let cache = &entries[1];
        assert_eq!(cache.container, None);
        assert_eq!((cache.category, cache.framework.as_deref()), (Category::Db, Some("Redis")), "the port rule, as today");
        assert_eq!(cache.project, None);
        assert!(cache.protected);

        let api = &entries[2];
        assert_eq!(api.container.as_deref(), Some("api"));
        assert_eq!((api.category, api.framework.as_deref()), (Category::Api, Some("ghcr.io/acme/shop-api")));

        let dns = &entries[3];
        assert_eq!(dns.container.as_deref(), Some("dns"), "udp matches udp");
        assert_eq!((dns.category, dns.framework.as_deref()), (Category::System, Some("coredns/coredns")));

        let node = &entries[4];
        assert_eq!(node.container, None, "not a Docker process");
        assert_eq!(node.project, None);
    }

    #[test]
    fn without_docker_running_nothing_is_attached_and_the_listing_still_succeeds() {
        // The CLI's absence, as `docker::fetch_with_path` sees it with an empty PATH, is an
        // empty list; against it every entry keeps `None`.
        let none = crate::docker::fetch_with_path(&std::ffi::OsString::new());
        assert!(none.is_empty());
        let mut entries = vec![docker_entry(5432, Protocol::Tcp)];
        attach_containers(&mut entries, &none);
        assert_eq!(entries[0].container, None);
        assert_eq!(entries[0].project, None);
        assert!(entries[0].protected, "Docker stays protected either way");

        // And the real listing, on a machine where Docker may or may not answer, still lists
        // our own socket, which no container publishes.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let pid = std::process::id();
        let entries = list().unwrap();
        let ours = entries.iter().find(|e| e.port == port && e.pid == pid).expect("our listener");
        assert_eq!(ours.container, None);
    }

    /// `ollama serve` as `brew services` runs it: launchd's child, owned by the current user,
    /// under /opt/homebrew, so WP-1's rule calls it an orphan.
    fn brew_service() -> PortEntry {
        let me = Some("amit");
        let exe = "/opt/homebrew/Cellar/ollama/0.13.0/bin/ollama";
        let mut e = PortEntry {
            port: 11434,
            process_name: "ollama".into(),
            command: format!("{exe} serve"),
            exe: Some(exe.into()),
            pid: 32014,
            protected: false,
            category: Category::Ai,
            framework: Some("Ollama".into()),
            ..docker_entry(11434, Protocol::Tcp)
        };
        e.orphan = is_orphan(e.parent_pid, e.exe.as_deref(), e.user.as_deref(), me);
        e.protected = is_protected(&e.process_name, e.exe.as_deref(), e.user.as_deref(), me);
        e
    }

    fn job(restarts: Option<bool>) -> LaunchdJob {
        LaunchdJob {
            label: "homebrew.mxcl.ollama".into(),
            restarts,
            brew: Some("ollama".into()),
            stop_command: Some("brew services stop ollama".into()),
        }
    }

    #[test]
    fn a_launchd_job_is_never_an_orphan_and_one_that_restarts_asks_first() {
        let before = brew_service();
        assert!(before.orphan, "the finding: WP-1's rule alone calls a brew service a zombie");
        assert!(!before.protected);

        let mut restarts = brew_service();
        apply_launchd(&mut restarts, Some(job(Some(true))));
        assert!(!restarts.orphan);
        assert!(restarts.protected, "launchd undoes the kill: it asks first");
        assert_eq!(restarts.launchd, Some(job(Some(true))));

        // Stays down after a kill, or nobody can tell: not an orphan, and no more protected than before.
        for unknown in [Some(false), None] {
            let mut e = brew_service();
            apply_launchd(&mut e, Some(job(unknown)));
            assert!(!e.orphan, "{unknown:?}");
            assert!(!e.protected, "{unknown:?}");
            assert_eq!(e.launchd, Some(job(unknown)));
        }
        // A job never lifts a protection the entry already had.
        let mut db = PortEntry { protected: true, ..brew_service() };
        apply_launchd(&mut db, Some(job(Some(false))));
        assert!(db.protected);

        // No job: nothing changes.
        let mut plain = brew_service();
        apply_launchd(&mut plain, None);
        assert_eq!(plain, brew_service());
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

    #[test]
    fn list_sees_and_reaps_a_spawned_stdio_mcp_orphan() {
        use std::process::{Command, Stdio};

        // Spawn a short-lived parent shell that starts a backgrounded child carrying
        // `@modelcontextprotocol/server-test` in its argv, prints its PID, and exits at once
        // so launchd (pid 1) adopts the child.
        let output = Command::new("/bin/sh")
            .args([
                "-c",
                "(exec -a @modelcontextprotocol/server-test /bin/sleep 30) >/dev/null 2>&1 </dev/null & echo $!",
            ])
            .stdout(Stdio::piped())
            .output()
            .expect("spawn detached mcp-server child");
        let orphan_pid: u32 = String::from_utf8_lossy(&output.stdout).trim().parse().expect("valid child pid");

        // Give the parent a brief moment to exit so launchd (pid 1) is the parent.
        std::thread::sleep(std::time::Duration::from_millis(80));

        let entries = list().unwrap();
        let portless: Vec<_> = entries.iter().filter(|e| e.port == 0).collect();
        println!("Found {} portless (stdio) orphans on machine:", portless.len());
        for p in &portless {
            println!(
                "  - PID {} | {} | framework={:?} | category={:?} | project={:?} | RAM={} MB | cmd={}",
                p.pid,
                p.process_name,
                p.framework,
                p.category,
                p.project.as_ref().map(|proj| &proj.name),
                p.memory_bytes / (1024 * 1024),
                p.command
            );
        }

        let found = entries.iter().find(|e| e.pid == orphan_pid);
        // Clean up the child we spawned before asserting so we never leak it even if an assertion fails.
        let outcome = crate::kill::kill(&crate::model::KillRequest { pid: orphan_pid, force: false });
        assert!(matches!(outcome, crate::model::KillOutcome::Killed { .. }), "expected Killed outcome: {outcome:?}");

        let entry = found.expect("our detached stdio MCP child must be listed as a port 0 orphan");
        assert_eq!(entry.port, 0);
        assert_eq!(entry.address, "stdio");
        assert!(entry.orphan);
        assert!(!entry.protected);
        assert_eq!(entry.category, Category::Ai);
        assert_eq!(entry.framework.as_deref(), Some("MCP"));
    }
}
