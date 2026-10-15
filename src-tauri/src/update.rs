//! Auto-update from GitHub Releases.
//!
//! Owned by WP-16. On every `v*` tag the release workflow (`.github/workflows/release.yml`)
//! builds the app, signs an `.app.tar.gz` with the minisign key in the repository's secrets, and
//! publishes both with a `latest.json`. The updater plugin fetches that file from the endpoint in
//! `tauri.conf.json`, compares its version with the running app's, verifies the signature with
//! the public key baked in there, swaps the bundle in place, and the app relaunches.
//!
//! When: [`LAUNCH_DELAY`] after launch and then every [`CHECK_INTERVAL`] (release builds only: a
//! dev build runs from `target/debug` and has no bundle to replace), and on demand from the
//! tray's "Check for Updates…" or the UI's `check_for_updates` command. What the user sees is
//! decided by the [`Trigger`]: a found update is offered in a native dialog on the launch and
//! manual checks and always announced to the windows ([`AVAILABLE_EVENT`], the sidebar banner);
//! the download reports [`PROGRESS_EVENT`]; an install failure is [`ERROR_EVENT`] and a warning.
//! A silent check that cannot reach the server (the repository is private, no release yet, no
//! network) says nothing: the app stays quiet and tries again later. Nothing here may panic.
//!
//! The whole flow blocks (the dialog waits for a click, the download for bytes), so it runs on
//! its own thread and never on the main one: the `update-check` thread for the timer,
//! [`spawn_check`] for the tray, and a thread per command.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt as _};

use crate::tray::{info, warn};

/// How long after launch the first check runs: the window is up and the user is not waiting.
pub const LAUNCH_DELAY: Duration = Duration::from_secs(10);
/// How often the app checks after that.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// A download chunk is reported once this many bytes arrived since the last report.
pub const PROGRESS_STEP: u64 = 256 * 1024;
/// How much of the release notes the native dialog shows.
pub const NOTES_MAX_LINES: usize = 12;
pub const NOTES_MAX_CHARS: usize = 600;

/// Emitted to every window when a check found a newer release. Payload: [`Available`].
pub const AVAILABLE_EVENT: &str = "update:available";
/// Emitted while the update downloads. Payload: [`Progress`].
pub const PROGRESS_EVENT: &str = "update:progress";
/// Emitted when the download or the install failed; the app keeps running. Payload: [`Failure`].
pub const ERROR_EVENT: &str = "update:error";

/// The payload of [`AVAILABLE_EVENT`]: `update:available { version, notes, date }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    /// The release's version, as `latest.json` announces it: `0.3.0`.
    pub version: String,
    /// The release notes, or `None` when the release has none.
    pub notes: Option<String>,
    /// The release's `pub_date`, RFC 3339, as published.
    pub date: Option<String>,
}

/// The payload of [`PROGRESS_EVENT`]: `update:progress { downloaded, total }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub downloaded: u64,
    /// The `Content-Length`, or `None` when the server did not say.
    pub total: Option<u64>,
}

/// The payload of [`ERROR_EVENT`]: `update:error { message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub message: String,
}

/// Who asked for the check; decides what is shown and what is swallowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// Ten seconds after launch: a found update is offered in a dialog; anything else is quiet.
    Launch,
    /// Every six hours: the windows are told; no dialog.
    Timer,
    /// The tray item or the UI: a dialog for the offer, for "up to date" and for a failure.
    Manual,
}

impl Trigger {
    /// Whether a found update is offered in a native dialog, not only in the sidebar banner.
    pub fn offers_in_dialog(self) -> bool {
        matches!(self, Trigger::Launch | Trigger::Manual)
    }

    /// Whether "nothing newer" and "could not check" are told to the user, or only logged.
    pub fn reports_quiet_outcomes(self) -> bool {
        matches!(self, Trigger::Manual)
    }
}

/// What a check ended with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing newer than the running version.
    UpToDate,
    /// A newer release was found and is not installed yet (no dialog, or "Later").
    Available(Available),
    /// The check or the install failed; the message is what the user was (or would be) told.
    Failed(String),
}

/// Managed state: the update the last check found, so the banner's Update and Retry install it
/// without a second check.
#[derive(Default)]
pub struct UpdateState {
    found: Mutex<Option<Update>>,
}

/// Only a release build checks on its own: a dev build runs from `target/debug`, which the
/// updater could not replace, and would offer every release to the developer.
pub fn should_check_automatically(debug: bool) -> bool {
    !debug
}

/// Called once from `setup`: starts the `update-check` thread that checks [`LAUNCH_DELAY`] after
/// launch and every [`CHECK_INTERVAL`] after that. A dev build only logs that it will not.
pub fn setup(app: &AppHandle) {
    if !should_check_automatically(cfg!(debug_assertions)) {
        info("dev build: no automatic update checks; the tray's \"Check for Updates…\" still works");
        return;
    }
    let handle = app.clone();
    let spawned = std::thread::Builder::new().name("update-check".into()).spawn(move || {
        std::thread::sleep(LAUNCH_DELAY);
        check(&handle, Trigger::Launch);
        loop {
            std::thread::sleep(CHECK_INTERVAL);
            check(&handle, Trigger::Timer);
        }
    });
    if let Err(e) = spawned {
        warn(format_args!("could not start the update-check thread: {e}"));
    }
}

/// Runs a check on a fresh thread: the tray's menu handler is on the main thread and must not
/// wait for a dialog.
pub fn spawn_check(app: &AppHandle, trigger: Trigger) {
    let app = app.clone();
    if let Err(e) = std::thread::Builder::new().name("update-manual".into()).spawn(move || {
        check(&app, trigger);
    }) {
        warn(format_args!("could not start the update check: {e}"));
    }
}

/// The async commands' way in: runs `work` on its own thread and waits for its answer without
/// holding a runtime worker. The thread never answers when the install relaunched the app.
pub async fn on_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    std::thread::Builder::new()
        .name("update-command".into())
        .spawn(move || {
            let _ = tx.blocking_send(work());
        })
        .map_err(|e| format!("could not start the update thread: {e}"))?;
    rx.recv().await.ok_or_else(|| "the update thread ended without an answer".to_string())
}

/// The flow: ask the endpoint, remember and announce what it found, offer it when the trigger
/// says so, install on "Update & relaunch" (which never returns: the app restarts). Blocking;
/// never call it on the main thread.
pub fn check(app: &AppHandle, trigger: Trigger) -> Outcome {
    let version = app.package_info().version.to_string();
    match find_update(app) {
        Ok(Some(update)) => {
            let available = Available::from_update(&update);
            info(format_args!("update available: {} (running {version})", available.version));
            remember(app, Some(update.clone()));
            emit(app, AVAILABLE_EVENT, &available);
            if trigger.offers_in_dialog() && offer(app, &available) {
                match install(app, &update) {
                    Ok(never) => match never {},
                    Err(message) => {
                        // The user asked from a dialog, so the answer comes in one too: the
                        // window may be hidden.
                        message_dialog(app, "Update failed", &message, MessageDialogKind::Error);
                        Outcome::Failed(message)
                    }
                }
            } else {
                Outcome::Available(available)
            }
        }
        Ok(None) => {
            info(format_args!("up to date ({version})"));
            if trigger.reports_quiet_outcomes() {
                message_dialog(app, "PortReaper", &up_to_date_message(&version), MessageDialogKind::Info);
            }
            Outcome::UpToDate
        }
        Err(e) => {
            let message = describe(&e);
            // A 404 (private repository, no release yet) or no network: quiet unless asked.
            warn(format_args!("update check failed: {message} ({e})"));
            if trigger.reports_quiet_outcomes() {
                message_dialog(app, "PortReaper", &message, MessageDialogKind::Warning);
            }
            Outcome::Failed(message)
        }
    }
}

/// Downloads and installs the update the last check found (the banner's Update and Retry), then
/// relaunches. `Err` with what the user should read when there is nothing to install or the
/// install failed; the failure was also emitted as [`ERROR_EVENT`].
pub fn install_found(app: &AppHandle) -> Result<(), String> {
    let Some(update) = remembered(app) else {
        return Err("No update to install yet. Check for updates first.".to_string());
    };
    install(app, &update).map(|never| match never {})
}

/// Asks the endpoint. `Ok(None)` when nothing is newer.
fn find_update(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    let updater = app.updater()?;
    tauri::async_runtime::block_on(updater.check())
}

/// The download with its progress events, then the install, then the restart, which does not
/// return. On failure the app keeps running the current version: the error is emitted and
/// logged and the update stays remembered for Retry.
fn install(app: &AppHandle, update: &Update) -> Result<std::convert::Infallible, String> {
    info(format_args!("downloading PortReaper {} from {}", update.version, update.download_url));
    let mut gate = ProgressGate::default();
    let result = tauri::async_runtime::block_on(update.download_and_install(
        |chunk, total| {
            if let Some(progress) = gate.advance(chunk, total) {
                emit(app, PROGRESS_EVENT, &progress);
            }
        },
        || info("update downloaded and verified; installing"),
    ));
    match result {
        Ok(()) => {
            info(format_args!("PortReaper {} installed; relaunching", update.version));
            app.restart()
        }
        Err(e) => {
            let message = describe(&e);
            warn(format_args!("update install failed: {message} ({e})"));
            emit(app, ERROR_EVENT, &Failure { message: message.clone() });
            Err(message)
        }
    }
}

/// The native offer: "Update & relaunch" is `true`, "Later" (or closing the dialog) `false`.
fn offer(app: &AppHandle, available: &Available) -> bool {
    let (title, message) = offer_text(available);
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Update & relaunch".into(), "Later".into()))
        .blocking_show()
}

fn message_dialog(app: &AppHandle, title: &str, message: &str, kind: MessageDialogKind) {
    app.dialog().message(message).title(title).kind(kind).buttons(MessageDialogButtons::Ok).blocking_show();
}

fn emit<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: &P) {
    if let Err(e) = app.emit(event, payload.clone()) {
        warn(format_args!("could not emit {event}: {e}"));
    }
}

fn remember(app: &AppHandle, update: Option<Update>) {
    match app.try_state::<UpdateState>() {
        Some(state) => match state.found.lock() {
            Ok(mut found) => *found = update,
            Err(e) => warn(format_args!("the update state is poisoned; not remembering the update: {e}")),
        },
        None => warn("the update state is not managed; the banner's Update will have nothing to install"),
    }
}

fn remembered(app: &AppHandle) -> Option<Update> {
    app.try_state::<UpdateState>().and_then(|state| state.found.lock().ok().and_then(|found| found.clone()))
}

impl Available {
    fn from_update(update: &Update) -> Self {
        Self {
            version: update.version.clone(),
            notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
            date: published_at(&update.raw_json),
        }
    }
}

/// The release's `pub_date` as published. The plugin parses it into a date type this crate does
/// not depend on, so the string is read back from the raw manifest.
pub fn published_at(raw_json: &serde_json::Value) -> Option<String> {
    raw_json.get("pub_date").and_then(|v| v.as_str()).map(str::to_string)
}

/// Decides which download chunks are worth an event: the first, then one per [`PROGRESS_STEP`],
/// and the last when the total is known.
#[derive(Debug, Default)]
pub struct ProgressGate {
    downloaded: u64,
    reported: Option<u64>,
}

impl ProgressGate {
    pub fn advance(&mut self, chunk: usize, total: Option<u64>) -> Option<Progress> {
        self.downloaded += chunk as u64;
        let done = total.is_some_and(|t| self.downloaded >= t);
        let due = match self.reported {
            None => true,
            Some(reported) => self.downloaded - reported >= PROGRESS_STEP,
        };
        if !(done || due) {
            return None;
        }
        self.reported = Some(self.downloaded);
        Some(Progress { downloaded: self.downloaded, total })
    }
}

/// `"You're up to date (0.2.0)"`.
pub fn up_to_date_message(version: &str) -> String {
    format!("You're up to date ({version})")
}

/// The dialog's title and message for a found update: the notes, trimmed to what a dialog can
/// show, and what happens on "Update & relaunch".
pub fn offer_text(available: &Available) -> (String, String) {
    let title = format!("PortReaper {} is available", available.version);
    let notes = available
        .notes
        .as_deref()
        .map(|notes| summarize(notes, NOTES_MAX_LINES, NOTES_MAX_CHARS))
        .unwrap_or_else(|| "A new version is ready to install.".to_string());
    let message = format!("{notes}\n\nPortReaper relaunches when the update is installed.");
    (title, message)
}

/// The first `max_lines` non-empty lines of `notes`, at most `max_chars` in all, with `…` when
/// something was left out.
pub fn summarize(notes: &str, max_lines: usize, max_chars: usize) -> String {
    let lines: Vec<&str> = notes.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    let mut out = lines.iter().take(max_lines).copied().collect::<Vec<_>>().join("\n");
    let mut cut = lines.len() > max_lines;
    if out.chars().count() > max_chars {
        out = out.chars().take(max_chars).collect::<String>().trim_end().to_string();
        cut = true;
    }
    if cut {
        out.push('…');
    }
    out
}

/// What the user reads for an updater error. The endpoint's 404 (the repository is private, or
/// there is no release yet) and no network are one case; a bad signature is named, because
/// nothing was installed and the user should know why.
pub fn describe(error: &UpdaterError) -> String {
    match error {
        UpdaterError::ReleaseNotFound
        | UpdaterError::Reqwest(_)
        | UpdaterError::Network(_)
        | UpdaterError::EmptyEndpoints => "Couldn't reach the update server".to_string(),
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => "The update could not be verified".to_string(),
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => {
            "This release has no build for this Mac".to_string()
        }
        other => format!("The update could not be installed: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_payloads_match_the_ui_contract() {
        let available = Available {
            version: "0.3.0".into(),
            notes: Some("- The Board".into()),
            date: Some("2026-10-15T20:00:00Z".into()),
        };
        assert_eq!(
            serde_json::to_value(&available).unwrap(),
            serde_json::json!({ "version": "0.3.0", "notes": "- The Board", "date": "2026-10-15T20:00:00Z" })
        );
        let bare = Available { version: "0.3.0".into(), notes: None, date: None };
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            serde_json::json!({ "version": "0.3.0", "notes": null, "date": null })
        );
        assert_eq!(
            serde_json::to_value(Progress { downloaded: 42, total: Some(100) }).unwrap(),
            serde_json::json!({ "downloaded": 42, "total": 100 })
        );
        assert_eq!(
            serde_json::to_value(Progress { downloaded: 42, total: None }).unwrap(),
            serde_json::json!({ "downloaded": 42, "total": null })
        );
        assert_eq!(
            serde_json::to_value(Failure { message: "Couldn't reach the update server".into() }).unwrap(),
            serde_json::json!({ "message": "Couldn't reach the update server" })
        );
    }

    #[test]
    fn the_trigger_decides_what_is_shown() {
        assert!(Trigger::Launch.offers_in_dialog());
        assert!(Trigger::Manual.offers_in_dialog());
        assert!(!Trigger::Timer.offers_in_dialog(), "the six-hour check only feeds the banner");
        assert!(Trigger::Manual.reports_quiet_outcomes());
        assert!(!Trigger::Launch.reports_quiet_outcomes(), "a 404 at launch is swallowed");
        assert!(!Trigger::Timer.reports_quiet_outcomes());
    }

    #[test]
    fn only_a_release_build_checks_on_its_own() {
        assert!(should_check_automatically(false));
        assert!(!should_check_automatically(true), "a dev build has no bundle to replace");
    }

    #[test]
    fn errors_read_as_the_spec_says() {
        assert_eq!(describe(&UpdaterError::ReleaseNotFound), "Couldn't reach the update server", "the 404");
        assert_eq!(describe(&UpdaterError::Network("status 502".into())), "Couldn't reach the update server");
        assert_eq!(describe(&UpdaterError::EmptyEndpoints), "Couldn't reach the update server");
        assert_eq!(describe(&UpdaterError::SignatureUtf8("x".into())), "The update could not be verified");
        assert_eq!(describe(&UpdaterError::MissingSignedVersion), "The update could not be verified");
        assert_eq!(
            describe(&UpdaterError::SignedVersionMismatch { signed: "0.2.1".into(), announced: "0.3.0".into() }),
            "The update could not be verified"
        );
        assert_eq!(describe(&UpdaterError::TargetNotFound("darwin-x86_64".into())), "This release has no build for this Mac");
        assert_eq!(describe(&UpdaterError::FormatDate), "The update could not be installed: Failed to format date");
    }

    #[test]
    fn the_up_to_date_message_names_the_version() {
        assert_eq!(up_to_date_message("0.2.0"), "You're up to date (0.2.0)");
    }

    #[test]
    fn the_offer_shows_the_notes_or_a_default_line() {
        let with_notes = Available {
            version: "0.3.0".into(),
            notes: Some("- The Board\n- Auto-update\n".into()),
            date: None,
        };
        let (title, message) = offer_text(&with_notes);
        assert_eq!(title, "PortReaper 0.3.0 is available");
        assert_eq!(message, "- The Board\n- Auto-update\n\nPortReaper relaunches when the update is installed.");

        let bare = Available { version: "0.3.0".into(), notes: Some("  \n".into()), date: None };
        let (_, message) = offer_text(&Available { notes: None, ..bare.clone() });
        assert!(message.starts_with("A new version is ready to install."));
    }

    #[test]
    fn long_notes_are_cut_for_the_dialog() {
        let many: String = (1..=20).map(|i| format!("- line {i}\n")).collect();
        let cut = summarize(&many, 3, 600);
        assert_eq!(cut, "- line 1\n- line 2\n- line 3…");
        assert_eq!(summarize("- a\n\n\n- b", 12, 600), "- a\n- b", "blank lines are dropped");
        let long = "x".repeat(50);
        assert_eq!(summarize(&long, 12, 10), format!("{}…", "x".repeat(10)));
        assert_eq!(summarize("- a\n- b", 12, 600), "- a\n- b", "nothing left out, no ellipsis");
    }

    #[test]
    fn the_progress_gate_reports_the_first_chunk_each_step_and_the_end() {
        let mut gate = ProgressGate::default();
        let total = Some(1_000_000);
        assert_eq!(gate.advance(1000, total), Some(Progress { downloaded: 1000, total }), "the first chunk");
        assert_eq!(gate.advance(1000, total), None, "too soon");
        let step = usize::try_from(PROGRESS_STEP).unwrap();
        assert_eq!(gate.advance(step, total), Some(Progress { downloaded: 2000 + PROGRESS_STEP, total }));
        assert_eq!(gate.advance(1000, total), None);
        let rest = 1_000_000 - (3000 + step);
        assert_eq!(gate.advance(rest, total), Some(Progress { downloaded: 1_000_000, total }), "the end");

        let mut unknown = ProgressGate::default();
        assert!(unknown.advance(10, None).is_some());
        assert!(unknown.advance(10, None).is_none(), "no total: no end to report, only the steps");
        assert!(unknown.advance(step, None).is_some());
    }

    #[test]
    fn the_publish_date_is_read_back_from_the_manifest() {
        let raw = serde_json::json!({ "version": "0.3.0", "pub_date": "2026-10-15T20:00:00Z", "platforms": {} });
        assert_eq!(published_at(&raw).as_deref(), Some("2026-10-15T20:00:00Z"));
        assert_eq!(published_at(&serde_json::json!({ "version": "0.3.0" })), None);
        assert_eq!(published_at(&serde_json::json!({ "pub_date": 7 })), None, "not a string: left out");
    }
}
