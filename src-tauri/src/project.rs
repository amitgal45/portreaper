//! Project detection: from a process's working directory to "shop-api on feature/cart".
//!
//! Owned by WP-2. Pure functions over the filesystem, no subprocesses: the branch is read from
//! `.git/HEAD`, never from `git` itself, so a scan of forty processes stays under a few
//! milliseconds and works with no git on PATH.

use std::path::Path;

use crate::model::ProjectInfo;

/// Finds the project a process belongs to.
///
/// `cwd` is the process's working directory when the OS reports it; `exe` is its executable path,
/// used as a fallback (a globally installed CLI run from `~` has no useful cwd); `command` is the
/// full command line, used to name the tool (`vite`, `next dev`, `nest start`...).
pub fn detect(_cwd: Option<&Path>, _exe: Option<&Path>, _command: &str) -> Option<ProjectInfo> {
    // WP-2 replaces this stub.
    None
}
