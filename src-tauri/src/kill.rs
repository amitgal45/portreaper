//! Killing: graceful first, forceful second, and some processes never.
//!
//! Owned by WP-1. The contract this module must keep:
//! - `force == false`: SIGTERM, then poll up to `GRACE_MS`, then SIGKILL if still alive;
//! - `force == true`: SIGKILL at once;
//! - refuses pid 0, pid 1 and our own pid before sending anything;
//! - a permission error is `Refused`, not `Failed`: the user needs to know they cannot kill it,
//!   not that something broke.

use crate::model::{KillOutcome, KillRequest};

/// How long a process gets to shut down cleanly before SIGKILL.
pub const GRACE_MS: u64 = 3_000;

pub fn kill(request: &KillRequest) -> KillOutcome {
    // WP-1 replaces this stub.
    KillOutcome::Failed { pid: request.pid, error: "kill is not implemented yet (WP-1)".into() }
}
