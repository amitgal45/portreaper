//! The launchd jobs behind the user's processes: `brew services` formulae and every other
//! LaunchAgent in the user's domain.
//!
//! Why: `ports::is_orphan` calls a process of the user that launchd (pid 1) parents, outside the
//! system paths and outside a `.app`, an orphan: the signature of a dev server whose terminal
//! closed. A job launchd runs on purpose has exactly that signature (`brew services start ollama`
//! puts a plist in `~/Library/LaunchAgents`, and launchd starts the binary under `/opt/homebrew`),
//! so it read as a Zombie, came first in ⌘⇧K's pre-selection, and Reap zombies and the tray's
//! "Kill lost-terminal servers" killed it; with KeepAlive, launchd started it again about 10 s
//! later. A process this module names is never an orphan, and one whose job restarts after a
//! kill is protected (`ports::apply_launchd`).
//!
//! What is read: one `launchctl list` per [`REFRESH`] (pid → label, the caller's domain only:
//! `gui/<uid>` for a GUI app), from whichever listing asks first (the [`Cache`]), with a
//! [`LIST_TIMEOUT`]; and per job its plist at `~/Library/LaunchAgents/<label>.plist` (Homebrew's
//! convention, and where a user's own agents live), at most [`MAX_PLIST_BYTES`], for its
//! `KeepAlive`. Not macOS, no answer in time, a non-zero exit: no jobs, and the listing behaves
//! as before.
//!
//! Nothing is ever run but `/bin/launchctl list`: an absolute path, a fixed argument, no shell.
//! Nothing from a label or a plist reaches a command line PortReaper runs. The stop command
//! ([`stop_command`]) is text for the user to copy, built here once from a validated label.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

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
/// Where a user's LaunchAgents live, under their home.
const LAUNCH_AGENTS: &str = "Library/LaunchAgents";
/// The longest label [`is_safe_label`] accepts, and the longest formula [`brew_formula`] does.
const MAX_LABEL_LEN: usize = 255;
const MAX_FORMULA_LEN: usize = 100;

/// The running jobs of the user's domain, pid → label, from the cache or from one
/// `launchctl list` when the cache is older than [`REFRESH`]. Empty when `launchctl` is not
/// there (not macOS), did not answer in time, or failed: a listing then behaves as before, and
/// a failure is not worth a warning every two seconds.
pub fn running_jobs() -> HashMap<u32, String> {
    static CACHE: Cache = Cache::new();
    CACHE.get(Instant::now(), fetch)
}

/// One `launchctl list`, parsed. Any failure is an empty map.
fn fetch() -> HashMap<u32, String> {
    match crate::docker::run(LAUNCHCTL, &["list".into()], &OsString::from(LIST_PATH), LIST_TIMEOUT) {
        Ok(output) if output.success => parse_list(&output.stdout),
        _ => HashMap::new(),
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
/// job stays stopped across logins), else `launchctl bootout gui/<uid>/<label>` when the label
/// [`is_safe_label`], else `None`.
pub fn stop_command(label: &str, brew: Option<&str>, uid: u32) -> Option<String> {
    if let Some(formula) = brew.filter(|f| is_formula(f)) {
        return Some(format!("brew services stop {formula}"));
    }
    is_safe_label(label).then(|| format!("launchctl bootout gui/{uid}/{label}"))
}

/// Whether launchd starts the job in `agent` (a parsed plist) again after a kill, from its `KeepAlive`:
/// - absent: the job ran at load and stays down after a kill until the next load: `Some(false)`;
/// - a boolean: `true` restarts after any exit, signals included: `Some(b)`;
/// - a dictionary with `SuccessfulExit = false`: a signal death is not a successful exit, so it
///   restarts: `Some(true)` (the conditions are alternatives, so the others do not matter);
/// - a dictionary of only `SuccessfulExit = true` and `Crashed = true` (crash signals, not
///   SIGTERM or SIGKILL), or an empty one: `Some(false)`;
/// - any other key (`PathState`, `OtherJobEnabled`, `NetworkState`...) or value: it depends on
///   the moment, `None`. So is a plist whose top is not a dictionary.
pub(crate) fn restarts_from(agent: &plist::Value) -> Option<bool> {
    let job = agent.as_dictionary()?;
    let Some(keep_alive) = job.get("KeepAlive") else {
        return Some(false);
    };
    if let Some(always) = keep_alive.as_boolean() {
        return Some(always);
    }
    let conditions = keep_alive.as_dictionary()?;
    let flag = |key: &str| conditions.get(key).and_then(plist::Value::as_boolean);
    if flag("SuccessfulExit") == Some(false) {
        return Some(true);
    }
    let only_kill_proof = conditions.keys().all(|key| match key.as_str() {
        "SuccessfulExit" | "Crashed" => flag(key.as_str()) == Some(true),
        _ => false,
    });
    only_kill_proof.then_some(false)
}

/// [`restarts_from`] for the plist at `path`: `None` unless `path` is a regular file (a link to
/// one counts) of at most [`MAX_PLIST_BYTES`] that parses as a plist, XML or binary.
pub(crate) fn restarts_at(path: &Path) -> Option<bool> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_PLIST_BYTES {
        return None;
    }
    let agent = plist::Value::from_file(path).ok()?;
    restarts_from(&agent)
}

/// Everything the UI shows about the job `label`: the formula when `brew services` started it,
/// whether it restarts after a kill (from `<home>/Library/LaunchAgents/<label>.plist`, read only
/// for a label that is safe in a path: [`is_safe_label`], or a `brew services` label, whose
/// formula is), and the command that stops it for good.
pub fn describe(label: &str, home: Option<&Path>, uid: u32) -> LaunchdJob {
    let brew = brew_formula(label);
    let restarts = match home {
        Some(home) if is_safe_label(label) || brew.is_some() => {
            restarts_at(&home.join(LAUNCH_AGENTS).join(format!("{label}.plist")))
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

/// The label of `pid`'s job: its own, or its parent's (see [`MAX_JOB_HOPS`]). Stops at pid 1
/// (launchd is nobody's job), at a pid `parent` does not know, and at a pid that is its own parent.
pub(crate) fn job_of<'a>(
    pid: u32,
    jobs: &'a HashMap<u32, String>,
    parent: impl Fn(u32) -> Option<u32>,
) -> Option<&'a str> {
    let mut current = pid;
    for _ in 0..MAX_JOB_HOPS {
        if let Some(label) = jobs.get(&current) {
            return Some(label.as_str());
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
    jobs.get(&current).map(String::as_str)
}

/// One `launchctl list` answer, trusted for [`REFRESH`]. The lock is held while `launchctl`
/// runs, so two listings asking at once (the tray's thread and the UI's poll) cost one call.
pub(crate) struct Cache {
    inner: Mutex<Option<(Instant, HashMap<u32, String>)>>,
}

impl Cache {
    pub const fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// The cached map when it is younger than [`REFRESH`] at `now`, else what `fetch` returns,
    /// cached as of `now`.
    pub fn get(&self, now: Instant, fetch: impl FnOnce() -> HashMap<u32, String>) -> HashMap<u32, String> {
        // A thread that panicked while holding the cache leaves a usable map behind.
        let mut slot = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((at, jobs)) = slot.as_ref() {
            if now.saturating_duration_since(*at) < REFRESH {
                return jobs.clone();
            }
        }
        let jobs = fetch();
        *slot = Some((now, jobs.clone()));
        jobs
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use plist::{Dictionary, Value};
    use tempfile::TempDir;

    use super::*;

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
    fn stop_command_is_brew_services_stop_or_a_bootout_and_never_an_unsafe_string() {
        assert_eq!(stop_command("homebrew.mxcl.ollama", Some("ollama"), 501).as_deref(), Some("brew services stop ollama"));
        assert_eq!(
            stop_command("sh.brew.postgresql@17", Some("postgresql@17"), 501).as_deref(),
            Some("brew services stop postgresql@17")
        );
        assert_eq!(
            stop_command("com.example.agent", None, 501).as_deref(),
            Some("launchctl bootout gui/501/com.example.agent")
        );
        assert_eq!(
            stop_command("com.example.agent", None, 502).as_deref(),
            Some("launchctl bootout gui/502/com.example.agent"),
            "the uid is the caller's"
        );
        assert_eq!(stop_command("com.example.my agent", None, 501), None);
        assert_eq!(stop_command("x;rm -rf ~", None, 501), None);
        assert_eq!(stop_command("", None, 501), None);
        // Something that is not a formula never reaches the command; the label decides instead.
        assert_eq!(
            stop_command("com.example.agent", Some("x; rm -rf ~"), 501).as_deref(),
            Some("launchctl bootout gui/501/com.example.agent")
        );
        assert_eq!(stop_command("bad label", Some("-rf"), 501), None);
    }

    /// A job's plist as a value: `RunAtLoad`, and `KeepAlive` when given.
    fn job(keep_alive: Option<Value>) -> Value {
        let mut dict = Dictionary::new();
        dict.insert("RunAtLoad".to_string(), Value::Boolean(true));
        if let Some(keep_alive) = keep_alive {
            dict.insert("KeepAlive".to_string(), keep_alive);
        }
        Value::Dictionary(dict)
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
    fn restarts_follows_keep_alive() {
        // Absent: it ran at load and stays down after a kill.
        assert_eq!(restarts_from(&job(None)), Some(false));
        // A boolean says it outright.
        assert_eq!(restarts_from(&job(Some(Value::Boolean(true)))), Some(true));
        assert_eq!(restarts_from(&job(Some(Value::Boolean(false)))), Some(false));
        // A signal death is not a successful exit.
        assert_eq!(restarts_from(&job(Some(conditions(&[("SuccessfulExit", false)])))), Some(true));
        assert_eq!(
            restarts_from(&job(Some(conditions(&[("SuccessfulExit", false), ("NetworkState", true)])))),
            Some(true),
            "the conditions are alternatives: this one alone restarts it"
        );
        // Restarts only after exit 0, or after a crash signal: a kill is neither.
        assert_eq!(restarts_from(&job(Some(conditions(&[("SuccessfulExit", true)])))), Some(false));
        assert_eq!(restarts_from(&job(Some(conditions(&[("Crashed", true)])))), Some(false));
        assert_eq!(restarts_from(&job(Some(conditions(&[("SuccessfulExit", true), ("Crashed", true)])))), Some(false));
        assert_eq!(restarts_from(&job(Some(conditions(&[])))), Some(false));
        // Anything that depends on the moment, or that the rules do not cover, is unknown.
        assert_eq!(restarts_from(&job(Some(conditions(&[("NetworkState", true)])))), None);
        assert_eq!(restarts_from(&job(Some(conditions(&[("SuccessfulExit", true), ("OtherJobEnabled", true)])))), None);
        assert_eq!(restarts_from(&job(Some(conditions(&[("Crashed", false)])))), None);
        let mut path_state = Dictionary::new();
        path_state.insert("PathState".to_string(), Value::Dictionary(Dictionary::new()));
        assert_eq!(restarts_from(&job(Some(Value::Dictionary(path_state)))), None);
        let mut odd = Dictionary::new();
        odd.insert("SuccessfulExit".to_string(), Value::Dictionary(Dictionary::new()));
        assert_eq!(restarts_from(&job(Some(Value::Dictionary(odd)))), None, "not a boolean");
        // Not a job at all.
        assert_eq!(restarts_from(&Value::Boolean(true)), None);
    }

    /// An XML LaunchAgent as `brew services` writes one, with `keep_alive` as the value of
    /// `KeepAlive` (no key when empty) and a `Padding` string of `padding` bytes.
    fn agent(keep_alive: &str, padding: usize) -> String {
        let keep = if keep_alive.is_empty() { String::new() } else { format!("<key>KeepAlive</key>{keep_alive}\n") };
        let pad = "x".repeat(padding);
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n\
             <dict>\n\
             <key>Label</key>\n\
             <string>homebrew.mxcl.ollama</string>\n\
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

    fn write(dir: &TempDir, name: &str, contents: &str) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn restarts_at_reads_a_real_plist_and_nothing_else() {
        let dir = TempDir::new().unwrap();
        let on = write(&dir, "on.plist", &agent("<true/>", 0));
        assert_eq!(restarts_at(&on), Some(true));
        let signal = write(&dir, "signal.plist", &agent("<dict><key>SuccessfulExit</key><false/></dict>", 0));
        assert_eq!(restarts_at(&signal), Some(true));
        let none = write(&dir, "none.plist", &agent("", 0));
        assert_eq!(restarts_at(&none), Some(false));

        // A link to one is read; a directory, a missing file and anything that is not a plist are not.
        let link = dir.path().join("link.plist");
        std::os::unix::fs::symlink(&on, &link).unwrap();
        assert_eq!(restarts_at(&link), Some(true));
        assert_eq!(restarts_at(dir.path()), None);
        assert_eq!(restarts_at(&dir.path().join("missing.plist")), None);
        assert_eq!(restarts_at(&write(&dir, "text.plist", "this is not a plist\n")), None);
        assert_eq!(restarts_at(&write(&dir, "cut.plist", "<plist version=\"1.0\"><dict><key>KeepAlive</key><true/>")), None);

        // Over the cap it is not read, however valid; just under it, it is.
        let big = MAX_PLIST_BYTES as usize;
        assert_eq!(restarts_at(&write(&dir, "small.plist", &agent("<true/>", big - 2048))), Some(true));
        let oversized = write(&dir, "big.plist", &agent("<true/>", big));
        assert!(std::fs::metadata(&oversized).unwrap().len() > MAX_PLIST_BYTES);
        assert_eq!(restarts_at(&oversized), None);
    }

    #[test]
    fn describe_reads_the_agent_under_home_for_a_safe_label_only() {
        let home = TempDir::new().unwrap();
        let agents = home.path().join(LAUNCH_AGENTS);
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join("homebrew.mxcl.ollama.plist"), agent("<true/>", 0)).unwrap();
        std::fs::write(agents.join("sh.brew.postgresql@17.plist"), agent("<dict><key>SuccessfulExit</key><false/></dict>", 0)).unwrap();
        std::fs::write(agents.join("com.example.agent.plist"), agent("", 0)).unwrap();
        // Where `../../evil` would point if a label ever became a path unchecked.
        std::fs::write(home.path().join("evil.plist"), agent("<true/>", 0)).unwrap();

        assert_eq!(
            describe("homebrew.mxcl.ollama", Some(home.path()), 501),
            LaunchdJob {
                label: "homebrew.mxcl.ollama".into(),
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
        assert_eq!(plain.stop_command.as_deref(), Some("launchctl bootout gui/501/com.example.agent"));

        // No plist, or no home: unknown, and the stop command still stands.
        let gone = describe("com.example.gone", Some(home.path()), 501);
        assert_eq!(gone.restarts, None);
        assert_eq!(gone.stop_command.as_deref(), Some("launchctl bootout gui/501/com.example.gone"));
        let homeless = describe("homebrew.mxcl.ollama", None, 501);
        assert_eq!(homeless.restarts, None);
        assert_eq!(homeless.stop_command.as_deref(), Some("brew services stop ollama"));

        // An unsafe label is shown, and nothing is built from it.
        let evil = describe("../../evil", Some(home.path()), 501);
        assert_eq!(evil, LaunchdJob { label: "../../evil".into(), restarts: None, brew: None, stop_command: None });
    }

    #[test]
    fn job_of_walks_up_to_the_nearest_job() {
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
        assert_eq!(job_of(600, &jobs, &parent), Some("sh.brew.ollama"), "the job's own process");
        assert_eq!(job_of(501, &jobs, &parent), Some("homebrew.mxcl.mysql"), "mysqld under mysqld_safe");
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
        assert_eq!(job_of(1000, &near, &parent), Some("com.example.near"));
        let far = HashMap::from([(1000 + hops + 1, "com.example.far".to_string())]);
        assert_eq!(job_of(1000, &far, &parent), None);
    }

    #[test]
    fn the_cache_answers_from_memory_within_the_refresh_and_asks_again_after() {
        let cache = Cache::new();
        let calls = AtomicUsize::new(0);
        let fetch = || {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            HashMap::from([(4242u32, format!("call-{n}"))])
        };
        let t0 = Instant::now();
        assert_eq!(cache.get(t0, fetch)[&4242u32], "call-1");
        assert_eq!(cache.get(t0 + Duration::from_secs(4), fetch)[&4242u32], "call-1", "same map within 5 s");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cache.get(t0 + REFRESH, fetch)[&4242u32], "call-2", "refreshed at 5 s");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // An empty answer (not macOS, a timeout) is cached like any other: no retry storm.
        let cache = Cache::new();
        assert!(cache.get(t0, HashMap::new).is_empty());
        assert!(cache.get(t0 + Duration::from_secs(1), || panic!("must not be asked again")).is_empty());
    }
}
