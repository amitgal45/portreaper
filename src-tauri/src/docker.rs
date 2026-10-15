//! The Docker containers behind the ports Docker's backend holds.
//!
//! Owned by WP-20. A port published by a container shows up as `com.docker.backend`, which tells
//! the user nothing and offers a Kill that would take Docker Desktop down. This module names the
//! container and makes Kill mean `docker stop`.
//!
//! Source of truth: the Docker CLI (`docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'`),
//! because it is what the user has when they have containers. Nothing else is called: no socket,
//! no API. The call runs at most once per [`REFRESH`] from whichever listing asks first (the
//! [`Cache`]), with a [`PS_TIMEOUT`], and with `PATH` extended by [`EXTRA_PATH`] because a Login
//! Item's PATH is bare. No CLI, no daemon, a timeout: the cache holds an empty list and the app
//! behaves as before.
//!
//! [`stop`] is the kill path for a container entry: `docker stop -t 3`, or `docker kill` when
//! the user forced it. Nothing here panics; a failure is an empty list or a `Failed` outcome.

use std::ffi::OsString;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::model::{KillOutcome, Protocol};

/// How long one `docker ps` answer is trusted before the next listing asks again.
pub const REFRESH: Duration = Duration::from_secs(5);
/// How long `docker ps` gets. A daemon that is up answers in tens of milliseconds; one that is
/// starting or wedged must not hold the port list hostage.
pub const PS_TIMEOUT: Duration = Duration::from_millis(1500);
/// How long `docker stop` gets: its own 3 s grace plus the daemon's round trip.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// How long `docker kill` gets.
pub const KILL_TIMEOUT: Duration = Duration::from_secs(5);
/// The seconds `docker stop` waits before it kills the container.
const STOP_GRACE_S: &str = "3";
/// Where the CLI lives when the inherited PATH does not say: Docker Desktop's symlink, Homebrew,
/// Docker Desktop's own CLI plugins directory, and the bundle itself when the symlink was declined.
pub const EXTRA_PATH: &[&str] = &[
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "~/.docker/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
];
/// The CLI's own format for `docker ps`: one container per line, three tab-separated columns.
const PS_FORMAT: &str = "{{.Names}}\t{{.Image}}\t{{.Ports}}";

/// One running container as `docker ps` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Container {
    pub name: String,
    /// As `docker ps` prints it: `postgres:16`, `ghcr.io/acme/api:latest`.
    pub image: String,
    /// The host ports it publishes, sorted and distinct. Unpublished ports are not here.
    pub ports: Vec<(u16, Protocol)>,
}

/// The running containers, from the cache or from one `docker ps` when the cache is older than
/// [`REFRESH`]. Empty when Docker is not installed, not running, or did not answer in time.
pub fn containers() -> Vec<Container> {
    static CACHE: Cache = Cache::new();
    CACHE.get(Instant::now(), fetch)
}

/// Stops `name` (`docker stop -t 3`), or kills it at once when `force`. The outcome carries
/// `pid`, Docker's backend, so the UI sees the same shape a process kill gives it.
pub fn stop(name: &str, force: bool, pid: u32) -> KillOutcome {
    let args = match stop_args(name, force) {
        Ok(args) => args,
        Err(reason) => return KillOutcome::Refused { pid, reason },
    };
    let started = Instant::now();
    let timeout = if force { KILL_TIMEOUT } else { STOP_TIMEOUT };
    let waited = || u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match run("docker", &args, &docker_path(), timeout) {
        Ok(output) if output.success => KillOutcome::Killed { pid, graceful: !force, waited_ms: waited() },
        Ok(output) => {
            let error = first_line(&output.stderr);
            if error.contains("No such container") {
                KillOutcome::NotFound { pid }
            } else {
                KillOutcome::Failed { pid, error }
            }
        }
        Err(RunError::NotFound) => KillOutcome::Failed { pid, error: "the docker command is not installed".into() },
        Err(RunError::Timeout) => {
            KillOutcome::Failed { pid, error: format!("docker did not answer within {} s", timeout.as_secs()) }
        }
        Err(RunError::Io(error)) => KillOutcome::Failed { pid, error },
    }
}

/// The command line of a stop, without the program: `stop -t 3 NAME` or `kill NAME`. A name
/// Docker would never produce (empty, or one that reads as a flag) is refused rather than passed.
pub(crate) fn stop_args(name: &str, force: bool) -> Result<Vec<String>, String> {
    if !is_container_name(name) {
        return Err(format!("{name:?} is not a container name"));
    }
    Ok(if force {
        vec!["kill".into(), name.into()]
    } else {
        vec!["stop".into(), "-t".into(), STOP_GRACE_S.into(), name.into()]
    })
}

/// Docker's own rule for names: `[a-zA-Z0-9][a-zA-Z0-9_.-]+`.
fn is_container_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && chars.clone().next().is_some()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// One `docker ps`, parsed. Any failure is an empty list: an absent daemon is the normal state
/// of most machines and not worth a warning every five seconds.
fn fetch() -> Vec<Container> {
    fetch_with_path(&docker_path())
}

/// [`fetch`] with the `PATH` the CLI is looked up in, so a test can simulate its absence.
pub(crate) fn fetch_with_path(path: &OsString) -> Vec<Container> {
    match run("docker", &["ps".into(), "--format".into(), PS_FORMAT.into()], path, PS_TIMEOUT) {
        Ok(output) if output.success => parse_ps(&output.stdout),
        _ => Vec::new(),
    }
}

/// The inherited `PATH` followed by [`EXTRA_PATH`], `~` expanded.
fn docker_path() -> OsString {
    let home = std::env::var_os("HOME");
    let mut parts: Vec<OsString> = std::env::var_os("PATH").into_iter().filter(|p| !p.is_empty()).collect();
    for extra in EXTRA_PATH {
        match extra.strip_prefix("~/") {
            Some(rest) => {
                if let Some(home) = &home {
                    let mut dir = home.clone();
                    dir.push("/");
                    dir.push(rest);
                    parts.push(dir);
                }
            }
            None => parts.push(OsString::from(extra)),
        }
    }
    let mut path = OsString::new();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            path.push(":");
        }
        path.push(part);
    }
    path
}

/// The lines of `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'`. A line with fewer
/// than two columns is skipped; a container with no published port is listed with none.
pub(crate) fn parse_ps(output: &str) -> Vec<Container> {
    output
        .lines()
        .filter_map(|line| {
            let mut columns = line.split('\t');
            let name = columns.next()?.trim();
            let image = columns.next()?.trim();
            if name.is_empty() || image.is_empty() {
                return None;
            }
            let ports = parse_ports(columns.next().unwrap_or(""));
            Some(Container { name: name.to_string(), image: image.to_string(), ports })
        })
        .collect()
}

/// The host ports in a `docker ps` Ports column, sorted and distinct.
///
/// `0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 6379/tcp` is `[(5432, Tcp)]`: the IPv4 and
/// IPv6 twins are one port, and `6379/tcp` (no `->`) is exposed inside the container only. A
/// range (`3000-3002->3000-3002/tcp`) is every port in it; `127.0.0.1:` binds and `/udp` count.
pub fn parse_ports(column: &str) -> Vec<(u16, Protocol)> {
    let mut ports: Vec<(u16, Protocol)> = column.split(',').filter_map(|item| parse_mapping(item.trim())).flatten().collect();
    ports.sort_unstable_by_key(|(port, protocol)| (*port, *protocol != Protocol::Tcp));
    ports.dedup();
    ports
}

/// One `HOST:PORT->PORT/PROTO` item, or `None` for an unpublished or unreadable one.
fn parse_mapping(item: &str) -> Option<Vec<(u16, Protocol)>> {
    let (host, container) = item.split_once("->")?;
    let protocol = match container.rsplit_once('/').map(|(_, p)| p.trim().to_ascii_lowercase()) {
        Some(p) if p == "tcp" => Protocol::Tcp,
        Some(p) if p == "udp" => Protocol::Udp,
        // sctp and anything newer: nothing the list could show.
        _ => return None,
    };
    // The host port follows the last `:`; the address before it may be `0.0.0.0`, `[::]` or
    // `127.0.0.1`, and does not matter here: the socket scan already knows the bind.
    let port_part = host.rsplit_once(':').map_or(host, |(_, p)| p);
    let (first, last) = match port_part.split_once('-') {
        Some((a, b)) => (a.parse::<u16>().ok()?, b.parse::<u16>().ok()?),
        None => {
            let p = port_part.parse::<u16>().ok()?;
            (p, p)
        }
    };
    if first > last {
        return None;
    }
    Some((first..=last).map(|p| (p, protocol)).collect())
}

/// What the CLI said: the exit status and both streams, read to the end.
pub(crate) struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RunError {
    /// No such program on the PATH given.
    NotFound,
    /// Still running at the deadline; it was killed.
    Timeout,
    Io(String),
}

/// Runs `program` with `args` and the given `PATH`, both streams captured, and kills it at
/// `timeout`. The streams are drained on their own threads so a chatty child never blocks on a
/// full pipe while this thread waits for it.
pub(crate) fn run(program: &str, args: &[String], path: &OsString, timeout: Duration) -> Result<Output, RunError> {
    let mut child = Command::new(program)
        .args(args)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { RunError::NotFound } else { RunError::Io(e.to_string()) })?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let status = wait_until(&mut child, Instant::now() + timeout);
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    match status {
        Ok(Some(status)) => Ok(Output { success: status.success(), stdout, stderr }),
        Ok(None) => Err(RunError::Timeout),
        Err(e) => Err(RunError::Io(e.to_string())),
    }
}

fn drain(stream: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stream) = stream {
            // Docker's output is UTF-8; anything else is read lossily rather than refused.
            let mut bytes = Vec::new();
            if stream.read_to_end(&mut bytes).is_ok() {
                text = String::from_utf8_lossy(&bytes).into_owned();
            }
        }
        text
    })
}

/// Polls the child until it exits or `deadline` passes; past it the child is killed and reaped,
/// and `Ok(None)` says so.
fn wait_until(child: &mut Child, deadline: Instant) -> std::io::Result<Option<std::process::ExitStatus>> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The first non-empty line of what Docker printed, or a stand-in: the UI shows one sentence.
fn first_line(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.strip_prefix("Error response from daemon: ").unwrap_or(l).to_string())
        .unwrap_or_else(|| "docker gave no reason".to_string())
}

/// One `docker ps` answer, trusted for [`REFRESH`]. The lock is held while the CLI runs, so two
/// listings asking at once (the tray's thread and the UI's poll) cost one call, not two.
pub(crate) struct Cache {
    inner: Mutex<Option<(Instant, Vec<Container>)>>,
}

impl Cache {
    pub const fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// The cached list when it is younger than [`REFRESH`] at `now`, else what `fetch` returns,
    /// cached as of `now`.
    pub fn get(&self, now: Instant, fetch: impl FnOnce() -> Vec<Container>) -> Vec<Container> {
        // A thread that panicked while holding the cache leaves a usable list behind.
        let mut slot = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((at, list)) = slot.as_ref() {
            if now.saturating_duration_since(*at) < REFRESH {
                return list.clone();
            }
        }
        let list = fetch();
        *slot = Some((now, list.clone()));
        list
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    const TCP: Protocol = Protocol::Tcp;
    const UDP: Protocol = Protocol::Udp;

    #[test]
    fn parse_ports_table() {
        // Docker's documented forms: a published port with its IPv4 and IPv6 twins, an exposed
        // but unpublished port, a loopback bind, a range, udp, and the empty column.
        assert_eq!(parse_ports("0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp"), [(5432, TCP)]);
        assert_eq!(parse_ports("0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 6379/tcp"), [(5432, TCP)]);
        assert_eq!(parse_ports("6379/tcp"), []);
        assert_eq!(parse_ports("127.0.0.1:5433->5432/tcp"), [(5433, TCP)], "the host port, not the container's");
        assert_eq!(
            parse_ports("0.0.0.0:3000-3002->3000-3002/tcp, [::]:3000-3002->3000-3002/tcp"),
            [(3000, TCP), (3001, TCP), (3002, TCP)]
        );
        assert_eq!(parse_ports("0.0.0.0:53->53/udp, [::]:53->53/udp, 0.0.0.0:53->53/tcp"), [(53, TCP), (53, UDP)]);
        assert_eq!(parse_ports(""), []);
        assert_eq!(parse_ports("   "), []);
        // Sorted whatever the order Docker printed, and nonsense is skipped rather than fatal.
        assert_eq!(parse_ports("0.0.0.0:8080->80/tcp, 0.0.0.0:443->443/tcp"), [(443, TCP), (8080, TCP)]);
        assert_eq!(parse_ports("0.0.0.0:70000->80/tcp, garbage, 0.0.0.0:80->80/sctp, 0.0.0.0:81->81/tcp"), [(81, TCP)]);
        assert_eq!(parse_ports("0.0.0.0:3002-3000->3000-3002/tcp"), [], "a backwards range is not a range");
    }

    #[test]
    fn parse_ps_reads_one_container_per_line() {
        let output = "shop-db\tpostgres:16\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp\n\
                      cache\tredis:7\t6379/tcp\n\
                      api\tghcr.io/acme/shop-api:latest\t127.0.0.1:8080->8080/tcp\n\
                      broken line without tabs\n\
                      \n\
                      idle\tbusybox\t\n";
        let containers = parse_ps(output);
        assert_eq!(
            containers,
            [
                Container { name: "shop-db".into(), image: "postgres:16".into(), ports: vec![(5432, TCP)] },
                Container { name: "cache".into(), image: "redis:7".into(), ports: vec![] },
                Container { name: "api".into(), image: "ghcr.io/acme/shop-api:latest".into(), ports: vec![(8080, TCP)] },
                Container { name: "idle".into(), image: "busybox".into(), ports: vec![] },
            ]
        );
        assert!(parse_ps("").is_empty());
    }

    #[test]
    fn the_cache_answers_from_memory_within_the_refresh_and_asks_again_after() {
        let cache = Cache::new();
        let calls = AtomicUsize::new(0);
        let fetch = || {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            vec![Container { name: format!("call-{n}"), image: "busybox".into(), ports: vec![] }]
        };
        let t0 = Instant::now();
        assert_eq!(cache.get(t0, fetch)[0].name, "call-1");
        assert_eq!(cache.get(t0 + Duration::from_secs(4), fetch)[0].name, "call-1", "same list within 5 s");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cache.get(t0 + REFRESH, fetch)[0].name, "call-2", "refreshed at 5 s");
        assert_eq!(cache.get(t0 + REFRESH + Duration::from_secs(1), fetch)[0].name, "call-2");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // An empty answer (no daemon) is cached like any other: no retry storm.
        let cache = Cache::new();
        assert!(cache.get(t0, Vec::new).is_empty());
        assert!(cache.get(t0 + Duration::from_secs(1), || panic!("must not be asked again")).is_empty());
    }

    #[test]
    fn the_cache_survives_a_poisoned_lock() {
        let cache = std::sync::Arc::new(Cache::new());
        let t0 = Instant::now();
        cache.get(t0, || vec![Container { name: "kept".into(), image: "busybox".into(), ports: vec![] }]);
        let poisoner = std::sync::Arc::clone(&cache);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.inner.lock();
            panic!("poison the cache on purpose");
        })
        .join();
        assert!(cache.inner.is_poisoned());
        assert_eq!(cache.get(t0, || panic!("still cached"))[0].name, "kept");
    }

    #[test]
    fn an_absent_cli_is_an_empty_list() {
        // An empty PATH finds no `docker`: what a machine without Docker looks like.
        assert!(fetch_with_path(&OsString::new()).is_empty());
        assert_eq!(run("docker", &["ps".into()], &OsString::new(), PS_TIMEOUT).err(), Some(RunError::NotFound));
    }

    #[test]
    fn run_captures_both_streams_and_the_status() {
        let path = OsString::from("/bin:/usr/bin");
        let ok = run("sh", &["-c".into(), "printf 'out\\n'; printf 'err\\n' >&2".into()], &path, Duration::from_secs(5)).unwrap();
        assert!(ok.success);
        assert_eq!((ok.stdout.as_str(), ok.stderr.as_str()), ("out\n", "err\n"));
        let failed = run("sh", &["-c".into(), "echo nope >&2; exit 3".into()], &path, Duration::from_secs(5)).unwrap();
        assert!(!failed.success);
        assert_eq!(failed.stderr, "nope\n");
    }

    #[test]
    fn run_kills_a_child_that_outlives_the_timeout() {
        // Our own child, nobody else's: `sleep` started here and reaped here.
        let path = OsString::from("/bin:/usr/bin");
        let started = Instant::now();
        let result = run("sleep", &["30".into()], &path, Duration::from_millis(200));
        assert_eq!(result.err(), Some(RunError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(5), "the sleep was killed, not waited for");
    }

    #[test]
    fn stop_builds_docker_stop_or_docker_kill_and_refuses_impossible_names() {
        // The command line only: a real `docker stop` is never run by a test.
        assert_eq!(stop_args("shop-db", false).unwrap(), ["stop", "-t", "3", "shop-db"]);
        assert_eq!(stop_args("shop-db", true).unwrap(), ["kill", "shop-db"]);
        assert_eq!(stop_args("a1_b.c-d", false).unwrap(), ["stop", "-t", "3", "a1_b.c-d"]);
        for bad in ["", "-rm", "--all", "a", "shop db", "shop;db", "naïve"] {
            assert!(stop_args(bad, false).is_err(), "{bad:?}");
            assert!(stop_args(bad, true).is_err(), "{bad:?}");
        }
        // A refused name reaches the outcome without touching the CLI.
        assert_eq!(stop("--all", false, 42), KillOutcome::Refused { pid: 42, reason: "\"--all\" is not a container name".into() });
    }

    #[test]
    fn docker_errors_are_one_line_without_the_daemon_prefix() {
        assert_eq!(first_line("Error response from daemon: No such container: shop-db\n"), "No such container: shop-db");
        assert_eq!(first_line("\n  Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?\nmore\n"), "Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?");
        assert_eq!(first_line(""), "docker gave no reason");
    }

    #[test]
    fn the_path_keeps_the_inherited_one_and_appends_the_usual_places() {
        let path = docker_path().to_string_lossy().into_owned();
        let parts: Vec<&str> = path.split(':').collect();
        if let Some(inherited) = std::env::var_os("PATH").filter(|p| !p.is_empty()) {
            assert!(path.starts_with(&*inherited.to_string_lossy()), "{path}");
        }
        assert!(parts.contains(&"/usr/local/bin"), "{path}");
        assert!(parts.contains(&"/opt/homebrew/bin"), "{path}");
        assert!(parts.contains(&"/Applications/Docker.app/Contents/Resources/bin"), "{path}");
        if let Some(home) = std::env::var_os("HOME") {
            let docker_bin = format!("{}/.docker/bin", home.to_string_lossy());
            assert!(parts.contains(&docker_bin.as_str()), "{path}");
        }
        assert!(!parts.iter().any(|p| p.starts_with('~')), "~ is expanded: {path}");
    }
}
