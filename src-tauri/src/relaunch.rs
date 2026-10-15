//! Relaunch: a killed process started again from what the Taskline remembers of it.
//!
//! Owned by WP-10. A [`KillRecord`] holds the argv, cwd and exe the process had when it was
//! killed. [`start`] runs the remembered `exe` when it still exists (else `argv[0]`, found on
//! PATH), with `argv[1..]` and the original `argv[0]` as its name, in the same working
//! directory, with stdio on `/dev/null`, in a process group of its own so that it never shares
//! PortReaper's terminal or job control and outlives it. A thread waits for the child so that it
//! does not linger as a zombie when it exits while PortReaper still runs.
//!
//! The new process inherits **PortReaper's environment, not the original's**: the kernel hands
//! out no other process's environment, and a dev server started under a shell with `nvm` or a
//! project `.env` may not find the same `node` or the same variables on PortReaper's PATH. That
//! is why the remembered `exe`, the absolute path of the binary that actually ran, is preferred
//! as the program: `node` on PATH may be another version or none at all. What the server read
//! from its own `.env` file it reads again; what the shell exported it does not get.
//!
//! When PortReaper quits, the relaunched process is re-parented to launchd and shows up as a
//! lost-terminal server, which is what it is.

use std::os::unix::process::CommandExt as _;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Instant;

use tauri::AppHandle;

use crate::model::{RelaunchOutcome, TasklineEvent};
use crate::taskline::{self, KillRecord, Taskline};
use crate::tray::warn;

/// A relaunch that worked: the child, for whoever must wait for it, and the event recorded.
#[derive(Debug)]
pub(crate) struct Relaunched {
    pub child: Child,
    pub event: TasklineEvent,
}

/// Starts the process behind `event_id` again and records it. The caller owns the child: the
/// app hands it to [`reap_when_done`], a test kills and waits for it.
pub(crate) fn start(taskline: &Taskline, event_id: u64) -> Result<Relaunched, RelaunchOutcome> {
    let Some((source, record)) = taskline.source(event_id) else {
        return Err(RelaunchOutcome::NotFound { event_id });
    };
    let Some(record) = record.filter(|_| source.relaunchable) else {
        return Err(RelaunchOutcome::Failed { event_id, error: "nothing to relaunch".into() });
    };
    let mut command = build(&record).map_err(|error| RelaunchOutcome::Failed { event_id, error })?;
    let started = Instant::now();
    match command.spawn() {
        Ok(child) => {
            let event = taskline.record_relaunch(&source, child.id(), started.elapsed());
            Ok(Relaunched { child, event })
        }
        Err(e) => {
            let program = command.get_program().to_string_lossy();
            Err(RelaunchOutcome::Failed { event_id, error: format!("could not start {program}: {e}") })
        }
    }
}

/// The command a record describes, or why it cannot be built. Checked here rather than left to
/// `spawn`, whose "No such file or directory" would not say whether the program or the
/// directory is gone.
fn build(record: &KillRecord) -> Result<Command, String> {
    let Some(name) = record.argv.first() else {
        return Err("nothing to relaunch".into());
    };
    if !Path::new(&record.cwd).is_dir() {
        return Err(format!("the working directory {} no longer exists", record.cwd));
    }
    // The binary that ran, when it is still there; else the name as typed, resolved on PATH.
    let program = match record.exe.as_deref().filter(|exe| Path::new(exe).is_file()) {
        Some(exe) => exe,
        None => name.as_str(),
    };
    let mut command = Command::new(program);
    command
        .arg0(name)
        .args(&record.argv[1..])
        .current_dir(&record.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    Ok(command)
}

/// The command the UI invokes: starts the process behind `event_id` again, keeps it from
/// becoming a zombie, and tells the windows.
pub fn relaunch(app: &AppHandle, event_id: u64) -> RelaunchOutcome {
    let Some(taskline) = taskline::state(app) else {
        return RelaunchOutcome::Failed { event_id, error: "the Taskline is not set up".into() };
    };
    match start(&taskline, event_id) {
        Ok(Relaunched { child, event }) => {
            let pid = child.id();
            reap_when_done(child);
            taskline::emit(app, &event);
            RelaunchOutcome::Started { pid }
        }
        Err(outcome) => outcome,
    }
}

/// A child nobody waits for stays a zombie in `ps` after it exits, for as long as PortReaper
/// runs. One thread per relaunch blocks in `wait` and costs nothing while the server lives.
fn reap_when_done(mut child: Child) {
    let pid = child.id();
    let spawned = std::thread::Builder::new().name(format!("reap-{pid}")).spawn(move || {
        let _ = child.wait();
    });
    if let Err(e) = spawned {
        warn(format_args!("could not wait for the relaunched process {pid}; it will linger as a zombie when it exits: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tempfile::TempDir;

    use super::*;
    use crate::model::{BindScope, Category, EventKind, KillOutcome, KillRequest, PortEntry, Protocol};

    /// A child this test spawned, or was handed by `start`. Killed and reaped on drop, even when
    /// an assertion fails, so no test leaves a `sleep` or a zombie behind.
    struct Spawned(Child);

    impl Spawned {
        fn sleep() -> Self {
            Self(Command::new("sleep").arg("30").spawn().expect("spawn a test child"))
        }

        fn id(&self) -> u32 {
            self.0.id()
        }
    }

    impl Drop for Spawned {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 sends nothing; it only asks whether the pid exists.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    /// The entry a `sleep 30` child would have if it listened on a port.
    fn sleep_entry(pid: u32, cwd: &str) -> PortEntry {
        PortEntry {
            port: 43_210,
            protocol: Protocol::Tcp,
            bind: BindScope::Loopback,
            address: "127.0.0.1".into(),
            pid,
            process_name: "sleep".into(),
            command: "sleep 30".into(),
            cwd: Some(cwd.into()),
            exe: Some("/bin/sleep".into()),
            user: Some("amit".into()),
            memory_bytes: 1024,
            started_at: None,
            parent_pid: Some(std::process::id()),
            orphan: false,
            project: None,
            protected: false,
            category: Category::Other,
            framework: None,
            container: None,
        }
    }

    fn sleep_argv() -> Vec<String> {
        vec!["sleep".into(), "30".into()]
    }

    /// Kills `child` through the one kill path and returns the event it left, which must be
    /// relaunchable.
    fn kill_through_the_taskline(taskline: &Taskline, child: &Spawned, entry: &PortEntry, argv: &[String]) -> TasklineEvent {
        let (outcome, event) =
            taskline.kill_and_record(entry, Some(argv), &KillRequest { pid: child.id(), force: false }, None);
        assert!(matches!(outcome, KillOutcome::Killed { .. }), "{outcome:?}");
        assert!(event.relaunchable, "{event:?}");
        event
    }

    #[test]
    fn relaunch_brings_a_killed_child_back_as_a_new_pid() {
        let taskline = Taskline::default();
        let cwd = std::env::current_dir().unwrap();
        let child = Spawned::sleep();
        let old_pid = child.id();
        let event = kill_through_the_taskline(&taskline, &child, &sleep_entry(old_pid, &cwd.to_string_lossy()), &sleep_argv());
        drop(child);

        let relaunched = match start(&taskline, event.id) {
            Ok(relaunched) => relaunched,
            Err(outcome) => panic!("relaunch failed: {outcome:?}"),
        };
        let back = Spawned(relaunched.child);
        let new_pid = back.id();
        assert_ne!(new_pid, old_pid);
        assert!(alive(new_pid), "the relaunched sleep must be running");

        let recorded = relaunched.event;
        assert_eq!(recorded.kind, EventKind::Relaunched);
        assert_eq!(recorded.pid, new_pid);
        assert_eq!(recorded.message, format!("Relaunched sleep on port 43210 (new pid {new_pid})."));
        let events = taskline.events();
        assert_eq!(events.iter().map(|e| e.kind).collect::<Vec<_>>(), [EventKind::Relaunched, EventKind::PortFreed]);

        // Our own child: kill it the way the app would, then `Spawned` reaps it on drop.
        match crate::kill::kill(&KillRequest { pid: new_pid, force: true }) {
            KillOutcome::Killed { .. } => {}
            other => panic!("could not clean up the relaunched child: {other:?}"),
        }
        drop(back);
        assert!(!alive(new_pid), "the guard must have reaped it: a zombie would still answer kill(pid, 0)");
    }

    #[test]
    fn unknown_and_unrelaunchable_events_say_so() {
        let taskline = Taskline::default();
        assert!(matches!(start(&taskline, 42), Err(RelaunchOutcome::NotFound { event_id: 42 })));

        // A refused kill leaves an event that cannot be relaunched: pid 1 is never signalled.
        let entry = sleep_entry(1, "/");
        let (outcome, event) =
            taskline.kill_and_record(&entry, Some(&sleep_argv()), &KillRequest { pid: 1, force: false }, None);
        assert!(matches!(outcome, KillOutcome::Refused { .. }));
        assert!(!event.relaunchable);
        match start(&taskline, event.id) {
            Err(RelaunchOutcome::Failed { event_id, error }) => {
                assert_eq!(event_id, event.id);
                assert_eq!(error, "nothing to relaunch");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn a_vanished_working_directory_fails_before_anything_is_started() {
        let taskline = Taskline::default();
        let gone = TempDir::new().unwrap();
        let path = gone.path().to_string_lossy().into_owned();
        let child = Spawned::sleep();
        let event = kill_through_the_taskline(&taskline, &child, &sleep_entry(child.id(), &path), &sleep_argv());
        drop(child);
        drop(gone);

        match start(&taskline, event.id) {
            Err(RelaunchOutcome::Failed { error, .. }) => {
                assert!(error.contains("no longer exists") && error.contains(&path), "{error}");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
        assert_eq!(taskline.events().len(), 1, "nothing was recorded for a start that never happened");
    }

    #[test]
    fn a_missing_program_fails_naming_the_path() {
        let taskline = Taskline::default();
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        let child = Spawned::sleep();
        let mut entry = sleep_entry(child.id(), &cwd);
        // Neither the remembered binary nor argv[0] exists any more.
        entry.exe = Some("/nonexistent/portreaper-test/sleep".into());
        let argv = vec!["/nonexistent/portreaper-test/sleep".to_string(), "30".to_string()];
        let event = kill_through_the_taskline(&taskline, &child, &entry, &argv);
        drop(child);

        match start(&taskline, event.id) {
            Err(RelaunchOutcome::Failed { error, .. }) => {
                assert!(error.starts_with("could not start /nonexistent/portreaper-test/sleep:"), "{error}");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn the_remembered_exe_is_preferred_and_argv0_is_kept() {
        let taskline = Taskline::default();
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        let child = Spawned::sleep();
        let mut entry = sleep_entry(child.id(), &cwd);
        entry.exe = Some("/bin/sleep".into());
        // argv[0] as a shell would set it: not a path at all.
        let argv = vec!["sleep".to_string(), "30".to_string()];
        let event = kill_through_the_taskline(&taskline, &child, &entry, &argv);
        drop(child);

        let (_, record) = taskline.source(event.id).unwrap();
        let command = build(&record.unwrap()).unwrap();
        assert_eq!(command.get_program(), "/bin/sleep");
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["30"]);
        assert_eq!(command.get_current_dir().map(|d| d.to_string_lossy().into_owned()), Some(cwd));

        // Give the started child a moment to exist, then make sure it is gone.
        let relaunched = start(&taskline, event.id).unwrap_or_else(|o| panic!("{o:?}"));
        let back = Spawned(relaunched.child);
        std::thread::sleep(Duration::from_millis(20));
        assert!(alive(back.id()));
    }
}
