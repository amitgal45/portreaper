//! Listing: which process listens on which port, enriched with process and project details.
//!
//! Owned by WP-1. The contract this module must keep:
//! - one entry per (pid, port, protocol); an IPv4 and an IPv6 socket of the same process on the
//!   same port are one entry, with `bind` describing the widest reach;
//! - sorted by port, then pid;
//! - never panics on a process that vanished between the socket scan and the process lookup;
//! - fills `project` through `crate::project::detect`.

use crate::model::PortEntry;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PortsError {
    #[error("could not read listening sockets: {0}")]
    Listeners(String),
}

/// Every listening socket on this machine with the process behind it.
pub fn list() -> Result<Vec<PortEntry>, PortsError> {
    // WP-1 replaces this stub.
    Ok(Vec::new())
}
