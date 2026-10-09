//! Killing: graceful first, forceful second, and some processes never.
//!
//! Owned by WP-1. The contract this module must keep:
//! - `force == false`: SIGTERM, then poll up to `GRACE_MS`, then SIGKILL if still alive;
//! - `force == true`: SIGKILL at once;
//! - refuses pid 0, pid 1 and our own pid before sending anything;
//! - a permission error is `Refused`, not `Failed`: the user needs to know they cannot kill it,
//!   not that something broke.

use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

use crate::model::{KillOutcome, KillRequest};

/// How long a process gets to shut down cleanly before SIGKILL.
pub const GRACE_MS: u64 = 3_000;
/// How long SIGKILL gets. The kernel needs no cooperation from the process, so a second is plenty.
const FORCE_GRACE_MS: u64 = 1_000;
const POLL_INTERVAL: Duration = Duration::from_millis(100);

pub fn kill(request: &KillRequest) -> KillOutcome {
    let pid = request.pid;
    if let Some(reason) = refusal_for(pid, std::process::id()) {
        return KillOutcome::Refused { pid, reason: reason.into() };
    }
    // `refusal_for` proved the pid fits; a negative `pid_t` would address a whole process group.
    let raw = pid as libc::pid_t;

    let mut target = Target::new(pid);
    let started = Instant::now();
    let waited = || started.elapsed().as_millis() as u64;

    let first = if request.force { libc::SIGKILL } else { libc::SIGTERM };
    if let Err(err) = signal(raw, first) {
        return match err.raw_os_error() {
            Some(libc::ESRCH) => KillOutcome::NotFound { pid },
            Some(libc::EPERM) => {
                KillOutcome::Refused { pid, reason: "not permitted: it belongs to another user".into() }
            }
            _ => KillOutcome::Failed { pid, error: err.to_string() },
        };
    }

    if !request.force {
        if target.wait_until_gone(GRACE_MS) {
            return KillOutcome::Killed { pid, graceful: true, waited_ms: waited() };
        }
        match signal(raw, libc::SIGKILL) {
            Ok(()) => {}
            // It exited between the last poll and the SIGKILL: SIGTERM did the job after all.
            Err(err) if err.raw_os_error() == Some(libc::ESRCH) => {
                return KillOutcome::Killed { pid, graceful: true, waited_ms: waited() };
            }
            Err(err) => return KillOutcome::Failed { pid, error: err.to_string() },
        }
    }

    if target.wait_until_gone(FORCE_GRACE_MS) {
        KillOutcome::Killed { pid, graceful: false, waited_ms: waited() }
    } else {
        KillOutcome::Failed { pid, error: "still alive after SIGKILL".into() }
    }
}

/// Why we will not even try. Checked before any signal; `None` means go ahead.
pub fn refusal_for(pid: u32, self_pid: u32) -> Option<&'static str> {
    // kill(2) reads pid 0 as "my whole process group".
    if pid == 0 {
        return Some("pid 0");
    }
    if pid == 1 {
        return Some("launchd");
    }
    if pid == self_pid {
        return Some("that is PortReaper itself");
    }
    // A pid that does not fit `pid_t` can only come from a corrupt request, and the cast would
    // turn it into a process group.
    if libc::pid_t::try_from(pid).is_err() {
        return Some("not a valid pid");
    }
    None
}

fn signal(pid: libc::pid_t, signal: libc::c_int) -> std::io::Result<()> {
    // SAFETY: kill(2) takes two plain integers and touches no memory of ours.
    if unsafe { libc::kill(pid, signal) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// The process being killed, watched through sysinfo so that "gone" can be told from "zombie"
/// and from "a new process got the same pid".
struct Target {
    pid: Pid,
    system: System,
    start_time: Option<u64>,
}

impl Target {
    fn new(pid: u32) -> Self {
        let pid = Pid::from_u32(pid);
        let mut system = System::new();
        Self::refresh(&mut system, pid);
        let start_time = system.process(pid).map(|p| p.start_time());
        Self { pid, system, start_time }
    }

    fn refresh(system: &mut System, pid: Pid) {
        system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
    }

    /// Polls every `POLL_INTERVAL` until the process is gone or `budget_ms` is spent. The first
    /// check is immediate, so a process that dies at once costs no wait at all.
    fn wait_until_gone(&mut self, budget_ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(budget_ms);
        loop {
            if !self.alive() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn alive(&mut self) -> bool {
        // kill(pid, 0) fails only once the pid is unregistered. EPERM would mean the number now
        // belongs to someone else's process, so the one we signalled is gone either way.
        // SAFETY: signal 0 sends nothing; it only asks whether the pid exists.
        if unsafe { libc::kill(self.pid.as_u32() as libc::pid_t, 0) } != 0 {
            return false;
        }
        Self::refresh(&mut self.system, self.pid);
        match self.system.process(self.pid) {
            // A zombie passes kill(pid, 0) until its parent reaps it, but macOS has already torn
            // down its task, so sysinfo cannot build an entry for it: not visible is dead too.
            // Linux keeps the entry and reports it as Zombie.
            None => false,
            Some(p) if p.status() == ProcessStatus::Zombie => false,
            // Same pid, different start time: a new process got the number.
            Some(p) => self.start_time.is_none_or(|t| p.start_time() == t),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::{Child, Command};

    use super::*;

    /// A child this test spawned. Reaped on drop, even when an assertion fails, so no test leaves
    /// a zombie or a stray `sleep` behind.
    struct Spawned(Child);

    impl Spawned {
        fn new(program: &str, args: &[&str]) -> Self {
            Self(Command::new(program).args(args).spawn().expect("spawn a test child"))
        }

        fn request(&self, force: bool) -> KillRequest {
            KillRequest { pid: self.0.id(), force }
        }
    }

    impl Drop for Spawned {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn refusal_table() {
        let me = 4242;
        assert_eq!(refusal_for(0, me), Some("pid 0"));
        assert_eq!(refusal_for(1, me), Some("launchd"));
        assert_eq!(refusal_for(me, me), Some("that is PortReaper itself"));
        assert_eq!(refusal_for(u32::MAX, me), Some("not a valid pid"));
        assert_eq!(refusal_for(99_999, me), None);
    }

    #[test]
    fn graceful_kill_of_a_child() {
        let child = Spawned::new("sleep", &["30"]);
        match kill(&child.request(false)) {
            KillOutcome::Killed { pid, graceful: true, waited_ms } => {
                assert_eq!(pid, child.0.id());
                assert!(waited_ms < 1000, "waited {waited_ms} ms");
            }
            other => panic!("expected a graceful kill, got {other:?}"),
        }
    }

    #[test]
    fn term_ignorer_gets_killed() {
        // An ignored signal stays ignored across execve, so `sleep` itself shrugs off TERM, and
        // `spawn` returns only once the child has exec'd. A shell wrapper (`sh -c 'trap "" TERM;
        // sleep 30'`) races: the TERM can land before the shell has run `trap`, and when it does
        // not, killing the shell leaves its `sleep` orphaned for the rest of its 30 seconds.
        let mut command = Command::new("sleep");
        command.arg("30");
        // SAFETY: `signal` is async-signal-safe and the closure touches nothing else.
        unsafe {
            std::os::unix::process::CommandExt::pre_exec(&mut command, || {
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
                Ok(())
            });
        }
        let child = Spawned(command.spawn().expect("spawn a TERM-ignoring child"));
        match kill(&child.request(false)) {
            KillOutcome::Killed { graceful: false, waited_ms, .. } => {
                assert!(waited_ms >= GRACE_MS, "waited only {waited_ms} ms");
            }
            other => panic!("expected a forced kill, got {other:?}"),
        }
    }

    #[test]
    fn force_kill_is_immediate() {
        let child = Spawned::new("sleep", &["30"]);
        match kill(&child.request(true)) {
            KillOutcome::Killed { graceful: false, waited_ms, .. } => {
                assert!(waited_ms < 500, "waited {waited_ms} ms");
            }
            other => panic!("expected a forced kill, got {other:?}"),
        }
    }

    #[test]
    fn vanished_pid_is_not_found() {
        let mut child = Spawned::new("true", &[]);
        child.0.wait().unwrap();
        // The number could in theory already belong to a new process. Any outcome that sends no
        // fatal signal is acceptable; a kill is not.
        match kill(&child.request(false)) {
            KillOutcome::NotFound { .. } | KillOutcome::Refused { .. } => {}
            other => panic!("a reaped pid must not be killed: {other:?}"),
        }
    }

    #[test]
    fn refuses_launchd_and_itself_without_signalling() {
        // `refusal_for` runs before the first `libc::kill`; nothing observable says "no signal
        // was sent", the structure of `kill` is the proof.
        let me = std::process::id();
        for (pid, reason) in [(1, "launchd"), (0, "pid 0"), (me, "that is PortReaper itself")] {
            let outcome = kill(&KillRequest { pid, force: true });
            assert_eq!(outcome, KillOutcome::Refused { pid, reason: reason.into() });
        }
    }
}
