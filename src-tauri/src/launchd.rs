//! The launchd jobs behind the user's processes: `brew services` formulae and every other
//! LaunchAgent in the user's domain.
//!
//! Why: `ports::is_orphan` calls a process of the user that launchd (pid 1) parents, outside the
//! system paths and outside a `.app`, an orphan: the signature of a dev server whose terminal
//! closed. A job launchd runs on purpose has exactly that signature (`brew services start ollama`
//! puts a plist in `~/Library/LaunchAgents`, and launchd starts the binary under `/opt/homebrew`),
//! so it read as a Zombie, came first in ⌘⇧K's pre-selection, and Reap zombies and the tray's
//! "Kill lost-terminal servers" killed it; with KeepAlive, launchd started it again within
//! seconds. A process this module names is never an orphan, and one whose job restarts after a
//! kill is protected (`ports::apply_launchd`).
//!
//! What is read: one `launchctl list` per [`REFRESH`] (pid → label, the caller's domain only:
//! `gui/<uid>` for a GUI app), from whichever listing asks first (the [`Cache`]), with a
//! [`LIST_TIMEOUT`]; and again at once when a process that would read as lost
//! (`ports::is_refetch_trigger`: launchd's child, the user's, outside the system paths and any
//! `.app`), and that the answer does not name, started since it was asked for ([`needs_refetch`]):
//! a job launchd just started again (after Kill anyway, or a `brew services start`) has a pid the
//! answer has never seen, and must not read as a lost process until the next refresh. A new app,
//! XPC service or piece of macOS is no reason to ask again, nor is a start time after now (a clock
//! set back), and a failed answer waits out the refresh. Per job, its plist at
//! `~/Library/LaunchAgents/<label>.plist` (Homebrew's convention, and where a user's own agents
//! live), at most [`MAX_PLIST_BYTES`], opened once and without blocking, for its `KeepAlive`.
//! Not macOS, no answer in time, a non-zero exit: no answer ([`running_jobs`] is `None`), which is
//! not the same as no jobs. Until one comes, the listing calls none of launchd's children lost
//! (`ports::hold_orphans_while_jobs_unknown`): a job nobody can name must not fall into a bulk
//! kill that launchd undoes. The first such failure of a run is a warning.
//!
//! Nothing is ever run but `/bin/launchctl list`: an absolute path, a fixed argument, no shell.
//! Nothing from a label or a plist reaches a command line PortReaper runs. The stop command
//! ([`stop_command`]) is text for the user to copy, built here once from a validated label, and
//! never for one of Apple's jobs ([`is_apple_label`]): `launchctl list` names pieces of macOS
//! (Control Center, which holds :5000 for AirPlay Receiver) as jobs of the user's domain too.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::docker::{Output, RunError};
use crate::model::LaunchdJob;

/// How long one `launchctl list` answer is trusted before the next listing asks again.
pub const REFRESH: Duration = Duration::from_secs(5);
/// How long `launchctl list` gets. It answers in milliseconds; a wedged one must not hold the
/// port list hostage.
pub const LIST_TIMEOUT: Duration = Duration::from_millis(1500);
/// A job's plist larger than this is not read: a real one is well under a kilobyte.
pub const MAX_PLIST_BYTES: u64 = 256 * 1024;
/// The one program this module runs, by its absolute path: no PATH lookup, no shell.
const LAUNCHCTL: &str = "/bin/launchctl";
/// The PATH it runs with: fixed, so the user's PATH has no say in what runs.
const LIST_PATH: &str = "/usr/bin:/bin";
/// The prefix LaunchServices gives the job of every app the user opened
/// (`application.<bundle id>.<n>.<n>`).
const APP_PREFIX: &str = "application.";
/// Homebrew's label prefixes: `sh.brew.` today, `homebrew.mxcl.` in older releases.
const BREW_PREFIXES: &[&str] = &["sh.brew.", "homebrew.mxcl."];
/// The prefix of Apple's own jobs (`com.apple.controlcenter`...), matched in any case.
const APPLE_PREFIX: &str = "com.apple.";
/// Where a user's LaunchAgents live, under their home.
const LAUNCH_AGENTS: &str = "Library/LaunchAgents";
/// The plist keys with which launchd starts a job on demand (a timer, a socket, a watched path,
/// a queue, a mounted volume, a Mach lookup, an event): such a job can come back after a kill
/// whatever its `KeepAlive` says.
const ON_DEMAND_KEYS: &[&str] = &[
    "StartInterval",
    "StartCalendarInterval",
    "Sockets",
    "WatchPaths",
    "QueueDirectories",
    "StartOnMount",
    "MachServices",
    "LaunchEvents",
];
/// The longest label [`is_safe_label`] accepts, and the longest formula [`brew_formula`] does.
const MAX_LABEL_LEN: usize = 255;
const MAX_FORMULA_LEN: usize = 100;

/// The running jobs of the user's domain, pid → label. The cached answer of one `launchctl list`
/// while it is younger than [`REFRESH`] and still fresh for `triggers` (pid and start time, unix
/// seconds, of every process of the user's that launchd parents and that would read as lost:
/// `ports::is_refetch_trigger`): none of them that it does not name started since it was asked
/// for ([`needs_refetch`]). Else a new answer, once per call. `None` when `launchctl` gave no
/// answer: it is not there (not macOS), did not answer in time, or failed ([`fetch`]). The jobs are
/// then unknown, not none: the listing holds launchd's children back from the orphans until an
/// answer comes (`ports::hold_orphans_while_jobs_unknown`).
pub fn running_jobs(triggers: &[(u32, u64)]) -> Option<HashMap<u32, String>> {
    static CACHE: Cache = Cache::new();
    // Dated before `launchctl` runs: a process that starts while it runs counts as newer. The
    // same second bounds the start times that count: a later one is a clock that was set back.
    let now = unix_now();
    CACHE.get_fresh(Instant::now(), now, fetch, |answer| {
        needs_refetch(answer.ok, answer.fetched_at, now, unmapped_starts(triggers, &answer.jobs))
    })
}

/// Whether the answer of `launchctl list` asked for at `fetched_at` (unix seconds) is stale at
/// `now` (unix seconds): one of the would-be lost processes it does not name (`starts`, unix
/// seconds) started at or after that moment, and not after `now`. That is a job launchd started
/// since, likely one it restarted with a new pid; the same second counts, because start times are
/// whole seconds. A process older than the answer is one the answer saw, and not a job; one that
/// started after now is a clock that was set back, not news. A failed answer (`answered` false:
/// no `launchctl`, no answer in time, a non-zero exit) is never stale: asked again at once, it
/// would run, and fail, at every listing, so it waits out [`REFRESH`].
pub(crate) fn needs_refetch(answered: bool, fetched_at: u64, now: u64, starts: impl IntoIterator<Item = u64>) -> bool {
    answered && starts.into_iter().any(|started| (fetched_at..=now).contains(&started))
}

/// The start times of the `children` (pid, unix seconds) whose pid `jobs` does not name.
pub(crate) fn unmapped_starts(children: &[(u32, u64)], jobs: &HashMap<u32, String>) -> Vec<u64> {
    children.iter().filter(|(pid, _)| !jobs.contains_key(pid)).map(|&(_, started)| started).collect()
}

/// `jobs` without `own`, PortReaper's pid. When autostart starts PortReaper through its
/// LaunchAgent it is a job itself, and every process it relaunched (its direct children) would
/// carry its login item's label and stop command.
pub(crate) fn without_own(mut jobs: HashMap<u32, String>, own: u32) -> HashMap<u32, String> {
    jobs.remove(&own);
    jobs
}

/// Now, in unix seconds; 0 for a clock before 1970.
fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// One `launchctl list`, parsed; `None` when it gave no answer ([`list_answer`]). The cache keeps
/// that as no answer, and while it stands no process launchd parents reads as lost, so none is
/// reaped (`ports::hold_orphans_while_jobs_unknown`): the first failure of a run says so on
/// stderr, and later ones do not, or a missing `launchctl` would warn at every listing.
fn fetch() -> Option<HashMap<u32, String>> {
    static WARNED: AtomicBool = AtomicBool::new(false);
    let ran = crate::docker::run(LAUNCHCTL, &["list".into()], &OsString::from(LIST_PATH), LIST_TIMEOUT);
    match list_answer(ran) {
        Ok(jobs) => Some(jobs),
        Err(why) => {
            if !WARNED.swap(true, Ordering::Relaxed) {
                crate::tray::warn(format_args!(
                    "launchctl list gave no jobs ({why}): launchd jobs cannot be told apart from lost \
                     processes; until launchctl answers, no process launchd parents is reaped (later \
                     failures are not logged)"
                ));
            }
            None
        }
    }
}

/// What one `launchctl list` run gave: its jobs, or why there are none.
pub(crate) fn list_answer(ran: Result<Output, RunError>) -> Result<HashMap<u32, String>, String> {
    match ran {
        Ok(output) if output.success => Ok(parse_list(&output.stdout)),
        Ok(_) => Err("it exited with an error".to_string()),
        Err(RunError::NotFound) => Err(format!("{LAUNCHCTL} is not there")),
        Err(RunError::Timeout) => Err(format!("no answer within {} ms", LIST_TIMEOUT.as_millis())),
        Err(RunError::Io(error)) => Err(error),
    }
}

/// The lines of `launchctl list`: `PID\tStatus\tLabel`, a header first, PID `-` for a job that
/// is not running. Skipped: the header and any line without three tab-separated fields, a PID
/// that is `-` or not a number above 1, an empty label, and LaunchServices' `application.*`
/// jobs (every app the user opened): an app is never an orphan already, and every shell in a
/// terminal app, so every dev server, would otherwise inherit its app's label through
/// [`job_of`]. The label is the rest of the line, kept as it is: [`is_safe_label`] decides
/// whether anything is built from it.
pub(crate) fn parse_list(output: &str) -> HashMap<u32, String> {
    let mut jobs = HashMap::new();
    for line in output.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let mut fields = line.splitn(3, '\t');
        let (Some(pid), Some(_status), Some(label)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let Ok(pid) = pid.trim().parse::<u32>() else {
            continue;
        };
        if pid <= 1 || label.is_empty() || label.starts_with(APP_PREFIX) {
            continue;
        }
        jobs.insert(pid, label.to_string());
    }
    jobs
}

/// Whether a label may become part of a path or of a command the user copies: 1–255 characters
/// of `[A-Za-z0-9._-]`, not starting with `.` or `-`. No `/`, no space, nothing a shell reads.
pub fn is_safe_label(label: &str) -> bool {
    (1..=MAX_LABEL_LEN).contains(&label.len())
        && !matches!(label.as_bytes().first(), Some(b'.' | b'-'))
        && label.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Whether `label` names one of Apple's jobs: it starts with `com.apple.`, in any case. Such a job
/// is a piece of macOS that `launchctl list` names in the user's domain like any LaunchAgent
/// (`com.apple.controlcenter`, which holds :5000 for AirPlay Receiver), and not the user's to
/// disable: [`stop_command`] builds nothing for it.
fn is_apple_label(label: &str) -> bool {
    // `get`: a label whose first bytes end inside a character is no `com.apple.` one, not a panic.
    label.get(..APPLE_PREFIX.len()).is_some_and(|head| head.eq_ignore_ascii_case(APPLE_PREFIX))
}

/// Whether `formula` reads as a Homebrew formula name: 1–100 characters of `[a-z0-9@._+-]`, not
/// starting with `-`. Nothing in it is special to a shell.
fn is_formula(formula: &str) -> bool {
    (1..=MAX_FORMULA_LEN).contains(&formula.len())
        && !formula.starts_with('-')
        && formula.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'@' | b'.' | b'_' | b'+' | b'-'))
}

/// The Homebrew formula behind a label `brew services` gave its job: the rest after `sh.brew.`
/// or `homebrew.mxcl.`, when that reads as a formula ([`is_formula`]).
pub fn brew_formula(label: &str) -> Option<String> {
    let rest = BREW_PREFIXES.iter().find_map(|prefix| label.strip_prefix(*prefix))?;
    is_formula(rest).then(|| rest.to_string())
}

/// What stops the job for good, for the user to copy (PortReaper never runs it):
/// `brew services stop <formula>` when `brew` names a formula (it also deletes the plist, so the
/// job stays stopped across logins); else, when the label [`is_safe_label`],
/// `launchctl disable gui/<uid>/<label> && launchctl bootout gui/<uid>/<label>` (`bootout` alone
/// stops it only until the next login loads the plist again; `disable` keeps it from loading);
/// else `None`. Never for one of Apple's jobs ([`is_apple_label`]): disabled, that piece of macOS
/// would most likely not load at the next login. `ports` also withholds it from a process that
/// runs from the system's folders.
pub fn stop_command(label: &str, brew: Option<&str>, uid: u32) -> Option<String> {
    if is_apple_label(label) {
        return None;
    }
    if let Some(formula) = brew.filter(|f| is_formula(f)) {
        return Some(format!("brew services stop {formula}"));
    }
    is_safe_label(label)
        .then(|| format!("launchctl disable gui/{uid}/{label} && launchctl bootout gui/{uid}/{label}"))
}

/// Whether launchd starts the job in `agent` (a parsed plist) again after a kill (SIGTERM, then
/// SIGKILL 3 s later if it still runs), as launchd.plist(5) reads its `KeepAlive`:
/// - `true`: it restarts after any exit, signals included: `Some(true)`.
/// - absent or `false`: it stays down until the next load: `Some(false)`; but `None` when the
///   job also starts on demand ([`ON_DEMAND_KEYS`]: a timer, a socket, a watched path...), which
///   a kill does not stop.
/// - a dictionary of conditions, each of which alone can restart it:
///   - `SuccessfulExit = false`: restarts unless the exit was successful, and a death by signal
///     is not: `Some(true)`. A server that exits 0 on SIGTERM is not restarted, so this can
///     protect one that a kill would stop for good; that fails safe (the kill asks first).
///   - `Crashed = false`: restarts unless it crashed, and a kill is no crash: `Some(true)`.
///   - `SuccessfulExit = true`: restarts after exit 0, which is what a server that handles
///     SIGTERM does: `None`.
///   - `Crashed = true`: restarts after a crash signal only, and SIGTERM and SIGKILL are none:
///     `Some(false)`, or `None` with an on-demand key as above.
///   - any other key (`PathState`, `OtherJobEnabled`, `NetworkState`, `AfterInitialDemand`...),
///     or a value that is not a boolean: it depends on the moment, `None`.
///
///   A condition that restarts it wins; else an unknown one makes the whole unknown; else
///   `Some(false)` (an empty dictionary included).
/// - anything else (a `KeepAlive` of another type, a top that is not a dictionary): `None`.
pub(crate) fn restarts_from(agent: &plist::Value) -> Option<bool> {
    let job = agent.as_dictionary()?;
    let verdict = match job.get("KeepAlive") {
        None => Some(false),
        Some(keep_alive) => keep_alive_verdict(keep_alive),
    };
    let on_demand = ON_DEMAND_KEYS.iter().any(|key| job.contains_key(key));
    match verdict {
        Some(false) if on_demand => None,
        verdict => verdict,
    }
}

/// What a `KeepAlive` value alone says about a kill: see [`restarts_from`].
fn keep_alive_verdict(keep_alive: &plist::Value) -> Option<bool> {
    if let Some(always) = keep_alive.as_boolean() {
        return Some(always);
    }
    let conditions = keep_alive.as_dictionary()?;
    let mut unknown = false;
    for key in conditions.keys() {
        match condition_verdict(key.as_str(), conditions.get(key.as_str())) {
            Some(true) => return Some(true),
            Some(false) => {}
            None => unknown = true,
        }
    }
    (!unknown).then_some(false)
}

/// What one `KeepAlive` condition says about a kill: see [`restarts_from`].
fn condition_verdict(key: &str, value: Option<&plist::Value>) -> Option<bool> {
    match (key, value.and_then(plist::Value::as_boolean)) {
        ("SuccessfulExit" | "Crashed", Some(false)) => Some(true),
        ("Crashed", Some(true)) => Some(false),
        // `SuccessfulExit = true`, every other key, and a value that is not a boolean.
        _ => None,
    }
}

/// [`restarts_from`] for the plist at `path`, the job `label`'s: `None` unless `path` is a
/// regular file (a link to one counts) of at most [`MAX_PLIST_BYTES`] that parses as a plist,
/// XML or binary, and whose `Label`, when it has one, is `label` (a plist that names another job
/// says nothing about this one).
pub(crate) fn restarts_at(path: &Path, label: &str) -> Option<bool> {
    let agent = read_plist(path)?;
    let named = agent.as_dictionary().and_then(|job| job.get("Label"));
    if named.is_some_and(|named| named.as_string() != Some(label)) {
        return None;
    }
    restarts_from(&agent)
}

/// The plist at `path`, read as [`restarts_at`] says. The file is opened once, and what is
/// checked is what is read: no other file can take its place between the check and the read.
fn read_plist(path: &Path) -> Option<plist::Value> {
    // O_NONBLOCK: opening a FIFO for reading does not wait for a writer. A regular file ignores it.
    let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_PLIST_BYTES {
        return None;
    }
    // One byte past the cap tells a file that grew since `metadata` from one that did not.
    let mut bytes = Vec::new();
    file.take(MAX_PLIST_BYTES + 1).read_to_end(&mut bytes).ok()?;
    let read = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if read > MAX_PLIST_BYTES {
        return None;
    }
    plist::Value::from_reader(std::io::Cursor::new(bytes)).ok()
}

/// Everything the UI shows about the job `label`: the formula when `brew services` started it,
/// whether it restarts after a kill (from `<home>/Library/LaunchAgents/<label>.plist`, read only
/// for a label that is safe in a path: [`is_safe_label`], or a `brew services` label, whose
/// formula is), and the command that stops it for good.
pub fn describe(label: &str, home: Option<&Path>, uid: u32) -> LaunchdJob {
    let brew = brew_formula(label);
    let restarts = match home {
        Some(home) if is_safe_label(label) || brew.is_some() => {
            restarts_at(&home.join(LAUNCH_AGENTS).join(format!("{label}.plist")), label)
        }
        _ => None,
    };
    let stop = stop_command(label, brew.as_deref(), uid);
    LaunchdJob { label: label.to_string(), restarts, brew, stop_command: stop }
}

/// How many parents [`job_of`] looks through: one, so a job's direct child counts (a job whose
/// process forks the server, `mysqld_safe` → `mysqld`, nginx's master → its workers) and
/// nothing further does. Further down, a job is a supervisor (a CI runner, a process manager)
/// whose descendants launchd does not restart, and labelling them would protect every process
/// it ever started.
pub const MAX_JOB_HOPS: usize = 1;

/// How a process belongs to the job [`job_of`] found for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Link {
    /// The job's own process: launchd started it, and the job's `KeepAlive` decides whether it
    /// comes back after a kill.
    Own,
    /// The job's direct child: its parent, not launchd, decides whether it comes back.
    Child,
}

/// The label of `pid`'s job, its own or its parent's (see [`MAX_JOB_HOPS`]), and which of the
/// two it is. Stops at pid 1 (launchd is nobody's job), at a pid `parent` does not know, and at
/// a pid that is its own parent.
pub(crate) fn job_of<'a>(
    pid: u32,
    jobs: &'a HashMap<u32, String>,
    parent: impl Fn(u32) -> Option<u32>,
) -> Option<(&'a str, Link)> {
    let link = |at: u32| if at == pid { Link::Own } else { Link::Child };
    let mut current = pid;
    for _ in 0..MAX_JOB_HOPS {
        if let Some(label) = jobs.get(&current) {
            return Some((label.as_str(), link(current)));
        }
        if current <= 1 {
            return None;
        }
        let next = parent(current)?;
        if next == current {
            return None;
        }
        current = next;
    }
    jobs.get(&current).map(|label| (label.as_str(), link(current)))
}

/// The job as the entry of a process with `link` to it carries it: the job's own process gets it
/// as [`describe`]d; a direct child gets `restarts: None` (whether it comes back after a kill is
/// its parent's business, not launchd's), and the same stop command (stopping the job stops it).
pub(crate) fn for_link(job: &LaunchdJob, link: Link) -> LaunchdJob {
    match link {
        Link::Own => job.clone(),
        Link::Child => LaunchdJob { restarts: None, ..job.clone() },
    }
}

/// One `launchctl list` answer: when it was taken (monotonic, for [`REFRESH`]; unix seconds, to
/// compare with start times), whether `launchctl` answered at all, and what it said.
pub(crate) struct Answer {
    at: Instant,
    fetched_at: u64,
    /// `false` when `launchctl` gave no answer ([`fetch`]): `jobs` is then empty, the cache gives
    /// `None` for it, and the answer is never stale before [`REFRESH`] ([`needs_refetch`]).
    ok: bool,
    jobs: HashMap<u32, String>,
}

/// One `launchctl list` answer, trusted for [`REFRESH`] unless a listing finds it stale. The lock
/// is held while `launchctl` runs, so two listings asking at once (the tray's thread and the UI's
/// poll) cost one call.
pub(crate) struct Cache {
    inner: Mutex<Option<Answer>>,
}

impl Cache {
    pub const fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// The cached answer when it is younger than [`REFRESH`] at `now` and `stale`, given the cached
    /// answer, says it is not; else what `fetch` returns, cached as of `now` and `unix_now`. Either
    /// way `None` when `launchctl` gave no answer (cached as no jobs and not `ok`): an empty map is
    /// an answer that names no job.
    pub fn get_fresh(
        &self,
        now: Instant,
        unix_now: u64,
        fetch: impl FnOnce() -> Option<HashMap<u32, String>>,
        stale: impl FnOnce(&Answer) -> bool,
    ) -> Option<HashMap<u32, String>> {
        // A thread that panicked while holding the cache leaves a usable map behind.
        let mut slot = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(answer) = slot.as_ref() {
            if now.saturating_duration_since(answer.at) < REFRESH && !stale(answer) {
                return answer.ok.then(|| answer.jobs.clone());
            }
        }
        let fetched = fetch();
        let jobs = fetched.clone().unwrap_or_default();
        *slot = Some(Answer { at: now, fetched_at: unix_now, ok: fetched.is_some(), jobs });
        fetched
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use plist::{Dictionary, Value};
    use tempfile::TempDir;

    use super::*;

    const OLLAMA: &str = "homebrew.mxcl.ollama";

    #[test]
    fn parse_list_reads_pid_and_label_and_skips_the_rest() {
        // What `launchctl list` prints, with every kind of line it must survive.
        let output = "PID\tStatus\tLabel\n\
                      32014\t0\thomebrew.mxcl.ollama\n\
                      -\t0\tsh.brew.redis\n\
                      1\t0\tcom.apple.launchd.peruser\n\
                      0\t0\tcom.example.zero\n\
                      4410\t-9\tcom.example.my agent\n\
                      4411\t0\n\
                      garbage\n\
                      \n\
                      4412\t0\t\n\
                      abc\t0\tcom.example.nan\n\
                      5120\t0\tsh.brew.postgresql@17\r\n\
                      6001\t0\tapplication.com.googlecode.iterm2.1234567.1234568\n\
                      6002\t0\tcom.example.tab\there\n";
        let expected = HashMap::from([
            (32014, "homebrew.mxcl.ollama".to_string()),
            // Kept as it is; is_safe_label keeps it out of every path and command.
            (4410, "com.example.my agent".to_string()),
            // CRLF: the carriage return is not part of the label.
            (5120, "sh.brew.postgresql@17".to_string()),
            // The label is the rest of the line, a tab included.
            (6002, "com.example.tab\there".to_string()),
        ]);
        assert_eq!(parse_list(output), expected);
        assert!(parse_list("").is_empty());
        assert!(parse_list("PID\tStatus\tLabel\n").is_empty(), "the header alone is no job");
        assert!(parse_list("PID\tStatus\tLabel\r\n-\t0\tsh.brew.redis\r\n").is_empty(), "a stopped job has no pid");
    }

    #[test]
    fn a_failed_launchctl_is_no_jobs_and_says_why() {
        // What `fetch` makes of each way `docker::run` can come back; nothing is run here.
        let listed = Output {
            success: true,
            stdout: "PID\tStatus\tLabel\n32014\t0\thomebrew.mxcl.ollama\n".into(),
            stderr: String::new(),
        };
        assert_eq!(list_answer(Ok(listed)), Ok(HashMap::from([(32014, OLLAMA.to_string())])));
        let refused = Output {
            success: false,
            stdout: "32014\t0\thomebrew.mxcl.ollama\n".into(),
            stderr: "Could not list\n".into(),
        };
        assert_eq!(
            list_answer(Ok(refused)),
            Err("it exited with an error".to_string()),
            "a non-zero exit is no answer, whatever it printed"
        );
        assert_eq!(list_answer(Err(RunError::NotFound)), Err("/bin/launchctl is not there".to_string()));
        assert_eq!(list_answer(Err(RunError::Timeout)), Err("no answer within 1500 ms".to_string()));
        assert_eq!(list_answer(Err(RunError::Io("denied".into()))), Err("denied".to_string()));
    }

    #[test]
    fn a_safe_label_is_plain_ascii_that_no_shell_or_path_reads_into() {
        for good in ["homebrew.mxcl.ollama", "sh.brew.redis", "com.example.agent_2", "a", "A-b.c_d9"] {
            assert!(is_safe_label(good), "{good}");
        }
        for bad in [
            "",
            ".hidden",
            "-flag",
            "has space",
            "semi;colon",
            "dollar$x",
            "back`tick",
            "quote'x",
            "slash/x",
            "../escape",
            "sh.brew.postgresql@17",
            "tab\tx",
            "naïve",
        ] {
            assert!(!is_safe_label(bad), "{bad:?}");
        }
        assert!(is_safe_label(&"a".repeat(255)));
        assert!(!is_safe_label(&"a".repeat(256)));
    }

    #[test]
    fn brew_formula_reads_both_prefixes_and_only_formula_names() {
        assert_eq!(brew_formula("homebrew.mxcl.ollama").as_deref(), Some("ollama"));
        assert_eq!(brew_formula("sh.brew.ollama").as_deref(), Some("ollama"));
        assert_eq!(brew_formula("sh.brew.redis").as_deref(), Some("redis"));
        assert_eq!(brew_formula("homebrew.mxcl.postgresql@17").as_deref(), Some("postgresql@17"));
        assert_eq!(brew_formula("sh.brew.postgresql@17").as_deref(), Some("postgresql@17"));
        // A prefix and nothing after it, a flag, uppercase and shell characters are not formulae.
        assert_eq!(brew_formula("sh.brew."), None);
        assert_eq!(brew_formula("homebrew.mxcl."), None);
        assert_eq!(brew_formula("sh.brew.-x"), None);
        assert_eq!(brew_formula("sh.brew.Ollama"), None);
        assert_eq!(brew_formula("homebrew.mxcl.OLLAMA"), None);
        assert_eq!(brew_formula("sh.brew.a b"), None);
        assert_eq!(brew_formula("sh.brew.a;b"), None);
        assert_eq!(brew_formula("sh.brew.a/b"), None);
        // Not Homebrew's.
        assert_eq!(brew_formula("com.example.ollama"), None);
        assert_eq!(brew_formula("xsh.brew.ollama"), None);
        assert_eq!(brew_formula(&format!("sh.brew.{}", "a".repeat(100))).map(|f| f.len()), Some(100));
        assert_eq!(brew_formula(&format!("sh.brew.{}", "a".repeat(101))), None);
    }

    #[test]
    fn stop_command_is_brew_services_stop_or_a_disable_and_bootout_and_never_an_unsafe_string() {
        assert_eq!(stop_command("homebrew.mxcl.ollama", Some("ollama"), 501).as_deref(), Some("brew services stop ollama"));
        assert_eq!(
            stop_command("sh.brew.postgresql@17", Some("postgresql@17"), 501).as_deref(),
            Some("brew services stop postgresql@17")
        );
        // Disabled first, so the next login does not load it again; then booted out of this session.
        assert_eq!(
            stop_command("com.example.agent", None, 501).as_deref(),
            Some("launchctl disable gui/501/com.example.agent && launchctl bootout gui/501/com.example.agent")
        );
        assert_eq!(
            stop_command("com.example.agent", None, 502).as_deref(),
            Some("launchctl disable gui/502/com.example.agent && launchctl bootout gui/502/com.example.agent"),
            "the uid is the caller's"
        );
        assert_eq!(stop_command("com.example.my agent", None, 501), None);
        assert_eq!(stop_command("x;rm -rf ~", None, 501), None);
        assert_eq!(stop_command("", None, 501), None);
        // Something that is not a formula never reaches the command; the label decides instead.
        assert_eq!(
            stop_command("com.example.agent", Some("x; rm -rf ~"), 501).as_deref(),
            Some("launchctl disable gui/501/com.example.agent && launchctl bootout gui/501/com.example.agent")
        );
        assert_eq!(stop_command("bad label", Some("-rf"), 501), None);

        // Apple's jobs are pieces of macOS: no command that would disable one, in any case, and
        // whatever formula a caller passes.
        assert_eq!(stop_command("com.apple.controlcenter", None, 501), None);
        assert_eq!(stop_command("COM.APPLE.x", None, 501), None);
        assert_eq!(stop_command("Com.Apple.sharingd", None, 501), None);
        assert_eq!(stop_command("com.apple.controlcenter", Some("ollama"), 501), None);
        // Only the prefix with its dot is Apple's.
        assert_eq!(
            stop_command("com.apples.agent", None, 501).as_deref(),
            Some("launchctl disable gui/501/com.apples.agent && launchctl bootout gui/501/com.apples.agent")
        );
    }

    #[test]
    fn an_apple_label_starts_with_com_apple_in_any_case() {
        for apple in ["com.apple.controlcenter", "COM.APPLE.x", "Com.Apple.sharingd", "com.apple."] {
            assert!(is_apple_label(apple), "{apple}");
        }
        for other in [
            "",
            "com.apple",
            "com.apples.agent",
            "xcom.apple.x",
            "homebrew.mxcl.ollama",
            // Not ASCII: a lookalike, and a label whose first ten bytes end inside a character.
            "çom.apple.x",
            "com.appleé.x",
        ] {
            assert!(!is_apple_label(other), "{other:?}");
        }
    }

    /// A job's plist as a value: `RunAtLoad`, `KeepAlive` when given, and each of `on_demand` as a key.
    fn job_with(keep_alive: Option<Value>, on_demand: &[&str]) -> Value {
        let mut dict = Dictionary::new();
        dict.insert("RunAtLoad".to_string(), Value::Boolean(true));
        if let Some(keep_alive) = keep_alive {
            dict.insert("KeepAlive".to_string(), keep_alive);
        }
        for key in on_demand {
            // Only the key's presence counts.
            dict.insert((*key).to_string(), Value::Boolean(true));
        }
        Value::Dictionary(dict)
    }

    fn job(keep_alive: Option<Value>) -> Value {
        job_with(keep_alive, &[])
    }

    /// A `KeepAlive` dictionary of boolean conditions.
    fn conditions(pairs: &[(&str, bool)]) -> Value {
        let mut dict = Dictionary::new();
        for (key, value) in pairs {
            dict.insert((*key).to_string(), Value::Boolean(*value));
        }
        Value::Dictionary(dict)
    }

    #[test]
    fn restarts_follows_keep_alive_as_launchd_plist_5_reads_it() {
        // `true` restarts after any exit, whatever else the job says.
        assert_eq!(restarts_from(&job(Some(Value::Boolean(true)))), Some(true));
        assert_eq!(restarts_from(&job_with(Some(Value::Boolean(true)), &["StartInterval"])), Some(true));

        // Absent or false: down until the next load, unless the job also starts on demand.
        assert_eq!(restarts_from(&job(None)), Some(false));
        assert_eq!(restarts_from(&job(Some(Value::Boolean(false)))), Some(false));
        for &key in ON_DEMAND_KEYS {
            assert_eq!(restarts_from(&job_with(None, &[key])), None, "{key}");
            assert_eq!(restarts_from(&job_with(Some(Value::Boolean(false)), &[key])), None, "{key}");
        }

        // A death by signal is no successful exit; a kill is no crash.
        assert_eq!(restarts_from(&job(Some(conditions(&[("SuccessfulExit", false)])))), Some(true));
        assert_eq!(restarts_from(&job(Some(conditions(&[("Crashed", false)])))), Some(true));
        // Exit 0 restarts it, and a server that handles SIGTERM exits 0: unknown.
        assert_eq!(restarts_from(&job(Some(conditions(&[("SuccessfulExit", true)])))), None);
        // A crash signal only: a kill is none, unless the job also starts on demand.
        assert_eq!(restarts_from(&job(Some(conditions(&[("Crashed", true)])))), Some(false));
        assert_eq!(restarts_from(&job_with(Some(conditions(&[("Crashed", true)])), &["WatchPaths"])), None);
        // Every other condition depends on the moment.
        for key in ["PathState", "OtherJobEnabled", "NetworkState", "AfterInitialDemand"] {
            assert_eq!(restarts_from(&job(Some(conditions(&[(key, true)])))), None, "{key}");
        }
        let mut path_state = Dictionary::new();
        path_state.insert("PathState".to_string(), Value::Dictionary(Dictionary::new()));
        assert_eq!(restarts_from(&job(Some(Value::Dictionary(path_state)))), None);
        let mut odd = Dictionary::new();
        odd.insert("SuccessfulExit".to_string(), Value::Dictionary(Dictionary::new()));
        assert_eq!(restarts_from(&job(Some(Value::Dictionary(odd)))), None, "not a boolean");

        // Two conditions: one that restarts it wins; else one unknown makes it unknown.
        let two = |a: (&str, bool), b: (&str, bool)| restarts_from(&job(Some(conditions(&[a, b]))));
        assert_eq!(two(("SuccessfulExit", false), ("NetworkState", true)), Some(true));
        assert_eq!(two(("SuccessfulExit", true), ("Crashed", false)), Some(true));
        assert_eq!(two(("Crashed", true), ("SuccessfulExit", true)), None);
        assert_eq!(two(("Crashed", true), ("OtherJobEnabled", true)), None);
        // No condition at all: nothing restarts it.
        assert_eq!(restarts_from(&job(Some(conditions(&[])))), Some(false));
        assert_eq!(restarts_from(&job_with(Some(conditions(&[])), &["MachServices"])), None);

        // Not a job's plist at all, or a KeepAlive of no known type.
        assert_eq!(restarts_from(&job(Some(Value::String("yes".into())))), None);
        assert_eq!(restarts_from(&Value::Boolean(true)), None);
    }

    /// An XML LaunchAgent as `brew services` writes one: `label` as its `Label` (no key when
    /// `None`), `keep_alive` as the value of `KeepAlive` (no key when empty), and a `Padding`
    /// string of `padding` bytes.
    fn agent_for(label: Option<&str>, keep_alive: &str, padding: usize) -> String {
        let name = label.map_or(String::new(), |l| format!("<key>Label</key>\n<string>{l}</string>\n"));
        let keep = if keep_alive.is_empty() { String::new() } else { format!("<key>KeepAlive</key>{keep_alive}\n") };
        let pad = "x".repeat(padding);
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n\
             <dict>\n\
             {name}\
             {keep}\
             <key>Padding</key>\n\
             <string>{pad}</string>\n\
             <key>ProgramArguments</key>\n\
             <array>\n\
             <string>/opt/homebrew/opt/ollama/bin/ollama</string>\n\
             <string>serve</string>\n\
             </array>\n\
             <key>RunAtLoad</key>\n\
             <true/>\n\
             </dict>\n\
             </plist>\n"
        )
    }

    /// [`agent_for`] Homebrew's ollama.
    fn agent(keep_alive: &str, padding: usize) -> String {
        agent_for(Some(OLLAMA), keep_alive, padding)
    }

    fn write(dir: &TempDir, name: &str, contents: &str) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn restarts_at_reads_a_real_plist_and_nothing_else() {
        let dir = TempDir::new().unwrap();
        let on = write(&dir, "on.plist", &agent("<true/>", 0));
        assert_eq!(restarts_at(&on, OLLAMA), Some(true));
        let signal = write(&dir, "signal.plist", &agent("<dict><key>SuccessfulExit</key><false/></dict>", 0));
        assert_eq!(restarts_at(&signal, OLLAMA), Some(true));
        let none = write(&dir, "none.plist", &agent("", 0));
        assert_eq!(restarts_at(&none, OLLAMA), Some(false));

        // A plist that names another job says nothing about this one; one that names none is read.
        assert_eq!(restarts_at(&on, "sh.brew.ollama"), None);
        let nameless = write(&dir, "nameless.plist", &agent_for(None, "<true/>", 0));
        assert_eq!(restarts_at(&nameless, OLLAMA), Some(true));
        let numbered = agent_for(None, "<true/>", 0).replace("<dict>\n", "<dict>\n<key>Label</key>\n<integer>7</integer>\n");
        assert_eq!(restarts_at(&write(&dir, "numbered.plist", &numbered), OLLAMA), None, "a Label that is no string");

        // A link to one is read; a directory, a missing file and anything that is not a plist are not.
        let link = dir.path().join("link.plist");
        std::os::unix::fs::symlink(&on, &link).unwrap();
        assert_eq!(restarts_at(&link, OLLAMA), Some(true));
        assert_eq!(restarts_at(dir.path(), OLLAMA), None);
        assert_eq!(restarts_at(&dir.path().join("missing.plist"), OLLAMA), None);
        assert_eq!(restarts_at(&write(&dir, "text.plist", "this is not a plist\n"), OLLAMA), None);
        assert_eq!(
            restarts_at(&write(&dir, "cut.plist", "<plist version=\"1.0\"><dict><key>KeepAlive</key><true/>"), OLLAMA),
            None
        );

        // Over the cap it is not read, however valid; just under it, it is.
        let big = MAX_PLIST_BYTES as usize;
        assert_eq!(restarts_at(&write(&dir, "small.plist", &agent("<true/>", big - 2048)), OLLAMA), Some(true));
        let oversized = write(&dir, "big.plist", &agent("<true/>", big));
        assert!(std::fs::metadata(&oversized).unwrap().len() > MAX_PLIST_BYTES);
        assert_eq!(restarts_at(&oversized, OLLAMA), None);
    }

    #[test]
    fn restarts_at_answers_at_once_for_a_fifo() {
        let dir = TempDir::new().unwrap();
        let fifo = dir.path().join("homebrew.mxcl.ollama.plist");
        let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: a NUL-terminated path in this test's own temporary directory.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0, "mkfifo {fifo:?}");
        // On its own thread, so a read that waits for a writer fails the test instead of hanging it.
        let (tx, rx) = std::sync::mpsc::channel();
        let path = fifo.clone();
        std::thread::spawn(move || {
            let _ = tx.send(restarts_at(&path, OLLAMA));
        });
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)), Ok(None), "a FIFO is no plist, and no reason to wait");
    }

    #[test]
    fn describe_reads_the_agent_under_home_for_a_safe_label_only() {
        let home = TempDir::new().unwrap();
        let agents = home.path().join(LAUNCH_AGENTS);
        std::fs::create_dir_all(&agents).unwrap();
        let install = |label: &str, keep_alive: &str| {
            std::fs::write(agents.join(format!("{label}.plist")), agent_for(Some(label), keep_alive, 0)).unwrap();
        };
        install(OLLAMA, "<true/>");
        install("sh.brew.postgresql@17", "<dict><key>SuccessfulExit</key><false/></dict>");
        install("com.example.agent", "");
        // A plist under one job's name that names another job.
        std::fs::write(agents.join("com.example.impostor.plist"), agent("<true/>", 0)).unwrap();
        // Where `../../evil` would point if a label ever became a path unchecked.
        std::fs::write(home.path().join("evil.plist"), agent_for(Some("../../evil"), "<true/>", 0)).unwrap();

        assert_eq!(
            describe(OLLAMA, Some(home.path()), 501),
            LaunchdJob {
                label: OLLAMA.into(),
                restarts: Some(true),
                brew: Some("ollama".into()),
                stop_command: Some("brew services stop ollama".into()),
            }
        );
        // A brew label with `@` is not safe in a command, but its formula is, and so is the path.
        let postgres = describe("sh.brew.postgresql@17", Some(home.path()), 501);
        assert_eq!(postgres.restarts, Some(true));
        assert_eq!(postgres.stop_command.as_deref(), Some("brew services stop postgresql@17"));

        let plain = describe("com.example.agent", Some(home.path()), 501);
        assert_eq!((plain.restarts, plain.brew.as_deref()), (Some(false), None));
        assert_eq!(
            plain.stop_command.as_deref(),
            Some("launchctl disable gui/501/com.example.agent && launchctl bootout gui/501/com.example.agent")
        );

        // No plist, a plist that names another job, or no home: unknown, and the stop command stands.
        let gone = describe("com.example.gone", Some(home.path()), 501);
        assert_eq!(gone.restarts, None);
        assert_eq!(
            gone.stop_command.as_deref(),
            Some("launchctl disable gui/501/com.example.gone && launchctl bootout gui/501/com.example.gone")
        );
        assert_eq!(describe("com.example.impostor", Some(home.path()), 501).restarts, None);
        let homeless = describe(OLLAMA, None, 501);
        assert_eq!(homeless.restarts, None);
        assert_eq!(homeless.stop_command.as_deref(), Some("brew services stop ollama"));

        // An unsafe label is shown, and nothing is built from it.
        let evil = describe("../../evil", Some(home.path()), 501);
        assert_eq!(evil, LaunchdJob { label: "../../evil".into(), restarts: None, brew: None, stop_command: None });

        // Apple's job (its plist is under /System, not this home): shown, and no command that would
        // disable a piece of macOS.
        let control_center = describe("com.apple.controlcenter", Some(home.path()), 501);
        assert_eq!(
            control_center,
            LaunchdJob { label: "com.apple.controlcenter".into(), restarts: None, brew: None, stop_command: None }
        );
    }

    #[test]
    fn job_of_finds_the_job_of_the_process_or_of_its_parent_and_says_which() {
        let jobs = HashMap::from([(500, "homebrew.mxcl.mysql".to_string()), (600, "sh.brew.ollama".to_string())]);
        let parents = HashMap::from([
            (500u32, 1u32),
            (501, 500),
            (502, 501),
            (600, 1),
            (700, 1),
            (701, 700),
            (800, 801),
            (801, 800),
            (900, 900),
        ]);
        let parent = |pid: u32| parents.get(&pid).copied();
        assert_eq!(job_of(600, &jobs, &parent), Some(("sh.brew.ollama", Link::Own)), "the job's own process");
        assert_eq!(job_of(500, &jobs, &parent), Some(("homebrew.mxcl.mysql", Link::Own)), "mysqld_safe, the job");
        assert_eq!(job_of(501, &jobs, &parent), Some(("homebrew.mxcl.mysql", Link::Child)), "mysqld under mysqld_safe");
        assert_eq!(job_of(502, &jobs, &parent), None, "two levels down is the supervisor's business, not launchd's");
        assert_eq!(job_of(701, &jobs, &parent), None, "launchd's child that is no job");
        assert_eq!(job_of(800, &jobs, &parent), None, "a loop in the parent links ends");
        assert_eq!(job_of(900, &jobs, &parent), None, "so does a self-parent");
        assert_eq!(job_of(999, &jobs, &parent), None, "a pid nobody knows");
        assert_eq!(job_of(1, &jobs, &parent), None, "launchd is nobody's job");
        assert_eq!(job_of(0, &jobs, &parent), None);
    }

    #[test]
    fn job_of_gives_up_after_max_job_hops() {
        let hops = MAX_JOB_HOPS as u32;
        // 1000 → 1001 → … → 1100, every link a parent.
        let parent = |pid: u32| (pid < 1100).then_some(pid + 1);
        let near = HashMap::from([(1000 + hops, "com.example.near".to_string())]);
        assert_eq!(job_of(1000, &near, &parent), Some(("com.example.near", Link::Child)));
        let far = HashMap::from([(1000 + hops + 1, "com.example.far".to_string())]);
        assert_eq!(job_of(1000, &far, &parent), None);
    }

    #[test]
    fn a_jobs_child_carries_the_job_and_its_stop_command_but_not_its_keep_alive() {
        let mysql = LaunchdJob {
            label: "homebrew.mxcl.mysql".into(),
            restarts: Some(true),
            brew: Some("mysql".into()),
            stop_command: Some("brew services stop mysql".into()),
        };
        assert_eq!(for_link(&mysql, Link::Own), mysql);
        assert_eq!(for_link(&mysql, Link::Child), LaunchdJob { restarts: None, ..mysql.clone() });
    }

    #[test]
    fn our_own_pid_is_never_a_job_for_the_listing() {
        let jobs = HashMap::from([(4242u32, "com.example.portreaper".to_string()), (32014, OLLAMA.to_string())]);
        assert_eq!(without_own(jobs.clone(), 4242), HashMap::from([(32014, OLLAMA.to_string())]));
        assert_eq!(without_own(jobs.clone(), 999), jobs, "not a job: nothing to drop");
    }

    #[test]
    fn a_launchd_child_the_answer_does_not_name_and_that_started_since_asks_again() {
        let fetched: u64 = 1_700_000_100;
        let now = fetched + 10;
        assert!(!needs_refetch(true, fetched, now, [fetched - 3600, fetched - 1]), "older: the answer saw them, and they are no job");
        assert!(needs_refetch(true, fetched, now, [fetched]), "the same second: it may have started after launchctl answered");
        assert!(needs_refetch(true, fetched, now, [fetched - 3600, fetched + 2]), "newer: a job launchd just started again");
        assert!(needs_refetch(true, fetched, now, [now]), "this very second counts too");
        assert!(!needs_refetch(true, fetched, now, std::iter::empty::<u64>()), "none");

        // Only the children the answer does not name count.
        let jobs = HashMap::from([(700u32, "sh.brew.ollama".to_string())]);
        let children = [(700u32, fetched + 5), (701, fetched - 10)];
        assert_eq!(unmapped_starts(&children, &jobs), [fetched - 10]);
        assert!(!needs_refetch(true, fetched, now, unmapped_starts(&children, &jobs)), "the new one is a job it knows");
        let children = [(700u32, fetched - 10), (702, fetched + 5)];
        assert!(needs_refetch(true, fetched, now, unmapped_starts(&children, &jobs)), "a new pid it has never seen");
        assert!(unmapped_starts(&[], &jobs).is_empty());
    }

    #[test]
    fn a_failed_answer_is_never_asked_again_before_the_refresh() {
        let fetched: u64 = 1_700_000_100;
        let now = fetched + 10;
        // No `launchctl`, no answer in time, a non-zero exit: asked again at once, it would run,
        // and fail, at every listing.
        assert!(!needs_refetch(false, fetched, now, [fetched, fetched + 2, now]), "new starts after a failed answer");
        assert!(!needs_refetch(false, fetched, now, std::iter::empty::<u64>()));
        assert!(needs_refetch(true, fetched, now, [fetched + 2]), "the same start after a real answer asks again");
    }

    #[test]
    fn a_start_time_after_now_is_no_reason_to_ask_again() {
        let fetched: u64 = 1_700_000_100;
        let now = fetched + 10;
        // The clock was set back after these started: their start times lie ahead of it.
        assert!(!needs_refetch(true, fetched, now, [now + 1, now + 3600]), "a start after now is a clock set back, not news");
        assert!(needs_refetch(true, fetched, now, [now + 3600, fetched + 5]), "one that started in between still counts");
        // Asked for before the clock went back an hour: no start is both since the answer and by now.
        assert!(!needs_refetch(true, fetched, fetched - 3600, [fetched, fetched + 5, fetched - 3600]));
    }

    #[test]
    fn the_cache_answers_from_memory_within_the_refresh_unless_stale_and_asks_again_after() {
        let cache = Cache::new();
        let calls = AtomicUsize::new(0);
        let fetch = || {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            Some(HashMap::from([(4242u32, format!("call-{n}"))]))
        };
        let fresh = |_: &Answer| false;
        let t0 = Instant::now();
        let secs = Duration::from_secs;
        assert_eq!(cache.get_fresh(t0, 100, fetch, fresh).expect("an answer")[&4242u32], "call-1");
        let again = cache.get_fresh(t0 + secs(4), 104, fetch, |answer: &Answer| {
            assert_eq!(answer.fetched_at, 100, "the unix second the answer was asked for");
            assert!(answer.ok, "launchctl answered");
            assert_eq!(answer.jobs[&4242u32], "call-1");
            false
        });
        assert_eq!(again.expect("an answer from memory")[&4242u32], "call-1", "same map within 5 s");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Stale within the refresh: asked again at once, and dated as of this ask.
        assert_eq!(cache.get_fresh(t0 + secs(4), 104, fetch, |_: &Answer| true).expect("an answer")[&4242u32], "call-2");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let dated = cache.get_fresh(t0 + secs(5), 105, || panic!("still fresh"), |answer: &Answer| {
            assert_eq!(answer.fetched_at, 104);
            false
        });
        assert_eq!(dated.expect("an answer from memory")[&4242u32], "call-2", "the refresh counts from the last ask");
        assert_eq!(
            cache.get_fresh(t0 + secs(4) + REFRESH, 109, fetch, fresh).expect("an answer")[&4242u32],
            "call-3",
            "refreshed after 5 s"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        // An empty answer is cached like any other, and is an answer: it names no job.
        let cache = Cache::new();
        assert_eq!(cache.get_fresh(t0, 100, || Some(HashMap::new()), fresh), Some(HashMap::new()));
        assert_eq!(
            cache.get_fresh(t0 + secs(1), 101, || panic!("must not be asked again"), fresh),
            Some(HashMap::new()),
            "from memory, still an answer"
        );

        // No answer (not macOS, a timeout): cached as no jobs and as no answer, so `needs_refetch`
        // lets it wait out the refresh (no retry storm), and the listing is told the jobs are
        // unknown (`None`), not that there are none; asked again after it.
        let cache = Cache::new();
        assert_eq!(cache.get_fresh(t0, 100, || None, fresh), None, "no answer is not an empty one");
        let failed = cache.get_fresh(t0 + secs(1), 101, || panic!("must not be asked again"), |answer: &Answer| {
            assert!(!answer.ok, "the cache knows launchctl gave no answer");
            assert!(answer.jobs.is_empty());
            assert_eq!(answer.fetched_at, 100);
            false
        });
        assert_eq!(failed, None, "from memory, still no answer");
        let retried = cache.get_fresh(t0 + REFRESH, 105, || Some(HashMap::from([(32014u32, OLLAMA.to_string())])), fresh);
        assert_eq!(retried.expect("an answer at last")[&32014u32], OLLAMA, "asked again after the refresh");
    }
}
