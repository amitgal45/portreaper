//! Port taxonomy: what kind of thing a port is, and the stack behind it when it can be named.
//!
//! Owned by WP-10. Pure and table-driven. [`classify`] reads what runs (the process name, the
//! tool `project::detect` found, the executable's file name, the command line) before it reads
//! the port number, so a Next.js server on 8080 is `Web` and a Rails app on 3000 is `Api`; the
//! port decides only when nothing about the process does. Every surface (the Studio, the HUD,
//! the tray) shows the same category because this is the one place it is decided.
//!
//! A framework name is a claim, so it is made only where the evidence is specific: a tool or a
//! process name names its product, and a port names one only where the port is that product's
//! by convention (5432 is PostgreSQL's, 11434 is Ollama's). A web or API port alone names
//! nothing: 3000 could be Next.js, Express, Rails or anything else.
//!
//! `Db` and `System` are always protected (`ports.rs` widens `protected` from the category), so
//! a wrong `Db` costs a second confirmation and a wrong `Other` could cost a database. Where the
//! tables are unsure they lean towards the protected categories.

use std::path::Path;

use crate::model::{Category, Protocol};
use crate::ports::SYSTEM_PREFIXES;

/// What a process is, by its name, its tool or its executable's file name. First match wins.
struct Rule {
    /// Matched as a token against the lowercased process name, exe file name and tool.
    needles: &'static [&'static str],
    category: Category,
    framework: Option<&'static str>,
}

/// Services: databases, model servers and macOS daemons. Checked before the system-path rule and
/// the dev tools, so a database is `Db` wherever it is installed.
const BY_SERVICE: &[Rule] = &[
    Rule { needles: &["postgres", "postgresql"], category: Category::Db, framework: Some("PostgreSQL") },
    Rule { needles: &["mysqld", "mysql"], category: Category::Db, framework: Some("MySQL") },
    Rule { needles: &["mariadbd", "mariadb"], category: Category::Db, framework: Some("MariaDB") },
    Rule { needles: &["mongod", "mongodb"], category: Category::Db, framework: Some("MongoDB") },
    Rule { needles: &["redis-server", "redis"], category: Category::Db, framework: Some("Redis") },
    Rule { needles: &["clickhouse"], category: Category::Db, framework: Some("ClickHouse") },
    Rule { needles: &["elasticsearch"], category: Category::Db, framework: Some("Elasticsearch") },
    Rule { needles: &["ollama"], category: Category::Ai, framework: Some("Ollama") },
    Rule { needles: &["lms", "lm-studio", "lm studio", "lmstudio"], category: Category::Ai, framework: Some("LM Studio") },
    Rule { needles: &["vllm"], category: Category::Ai, framework: Some("vLLM") },
    Rule { needles: &["llama-server", "llama.cpp"], category: Category::Ai, framework: Some("llama.cpp") },
    Rule { needles: &["text-generation"], category: Category::Ai, framework: None },
    // The macOS daemons of `ports::PROTECTED_NAMES`. The container runtimes there (Docker, colima,
    // OrbStack) are left to the port rule on purpose: `com.docker.backend` on 5432 is the user's
    // database in a container, not a piece of macOS. WP-1's rule keeps them protected either way.
    // Control Center is the AirPlay Receiver on 5000 and 7000; naming it here covers the case
    // where its executable path is not readable.
    Rule { needles: &["controlcenter"], category: Category::System, framework: Some("AirPlay") },
    Rule { needles: &["mdnsresponder"], category: Category::System, framework: Some("mDNS") },
    Rule { needles: &["cupsd"], category: Category::System, framework: Some("CUPS") },
    Rule { needles: &["sshd"], category: Category::System, framework: Some("SSH") },
    Rule { needles: &["rapportd", "sharingd", "launchd"], category: Category::System, framework: None },
];

/// Dev tools, by the name `project::detect_tool` gives them (or the process name, when a tool
/// renames its process, as `next-server` does).
const BY_TOOL: &[Rule] = &[
    Rule { needles: &["next"], category: Category::Web, framework: Some("Next.js") },
    Rule { needles: &["vite"], category: Category::Web, framework: Some("Vite") },
    Rule { needles: &["nuxt"], category: Category::Web, framework: Some("Nuxt") },
    Rule { needles: &["astro"], category: Category::Web, framework: Some("Astro") },
    Rule { needles: &["remix"], category: Category::Web, framework: Some("Remix") },
    Rule { needles: &["storybook"], category: Category::Web, framework: Some("Storybook") },
    Rule { needles: &["webpack"], category: Category::Web, framework: Some("Webpack") },
    Rule { needles: &["nest"], category: Category::Api, framework: Some("NestJS") },
    Rule { needles: &["uvicorn", "fastapi"], category: Category::Api, framework: Some("FastAPI") },
    Rule { needles: &["gunicorn", "django"], category: Category::Api, framework: Some("Django") },
    Rule { needles: &["flask"], category: Category::Api, framework: Some("Flask") },
    Rule { needles: &["rails"], category: Category::Api, framework: Some("Rails") },
    Rule { needles: &["go"], category: Category::Api, framework: Some("Go") },
];

/// The category of a listening socket and, when the evidence names one, its framework.
///
/// `tool` is `ProjectInfo::tool` (what `project::detect` read from the command line), `exe` the
/// executable path when known, `command` the joined command line (empty when unknown).
pub fn classify(
    port: u16,
    protocol: Protocol,
    tool: Option<&str>,
    process_name: &str,
    exe: Option<&str>,
    command: &str,
) -> (Category, Option<String>) {
    let (category, framework) = decide(port, protocol, tool, process_name, exe, command);
    (category, framework.map(str::to_string))
}

fn decide(
    port: u16,
    protocol: Protocol,
    tool: Option<&str>,
    process_name: &str,
    exe: Option<&str>,
    command: &str,
) -> (Category, Option<&'static str>) {
    let name = process_name.to_lowercase();
    let exe_file = exe.and_then(|e| Path::new(e).file_name()).map(|f| f.to_string_lossy().to_lowercase());
    let tool = tool.map(str::to_lowercase);
    let subjects = [Some(name.as_str()), exe_file.as_deref(), tool.as_deref()];
    let matches = |rule: &Rule| rule.needles.iter().any(|needle| subjects.iter().flatten().any(|s| named(s, needle)));

    // 1. By what runs: services, then anything that lives under a system root (macOS's, whatever
    //    it is called), then the dev tools, then Express, which only the command line names.
    if let Some(rule) = BY_SERVICE.iter().find(|rule| matches(rule)) {
        return (rule.category, rule.framework);
    }
    if exe.is_some_and(is_system_path) {
        return (Category::System, None);
    }
    if let Some(rule) = BY_TOOL.iter().find(|rule| matches(rule)) {
        return (rule.category, rule.framework);
    }
    if crate::project::occurs_as_token(&command.to_ascii_lowercase(), "express") {
        return (Category::Api, Some("Express"));
    }

    // 2. By port.
    if let Some(hit) = by_port(port, protocol) {
        return hit;
    }

    // 3. Nothing says what it is.
    (Category::Other, None)
}

/// Images whose repository names a product (WP-20). Keyed by the repository with the registry,
/// the `library/` prefix and the tag stripped, or by its last path segment, so `postgres:16`,
/// `docker.io/library/postgres` and `bitnami/postgresql` all read as PostgreSQL. The category
/// is the product's where it is a store or a model server; anything else keeps the port rule.
const BY_IMAGE: &[(&str, Option<Category>, &str)] = &[
    ("postgres", Some(Category::Db), "PostgreSQL"),
    ("postgresql", Some(Category::Db), "PostgreSQL"),
    ("redis", Some(Category::Db), "Redis"),
    ("valkey", Some(Category::Db), "Valkey"),
    ("mongo", Some(Category::Db), "MongoDB"),
    ("mongodb", Some(Category::Db), "MongoDB"),
    ("mysql", Some(Category::Db), "MySQL"),
    ("mariadb", Some(Category::Db), "MariaDB"),
    ("rabbitmq", Some(Category::Db), "RabbitMQ"),
    ("elasticsearch", Some(Category::Db), "Elasticsearch"),
    ("clickhouse", Some(Category::Db), "ClickHouse"),
    ("clickhouse-server", Some(Category::Db), "ClickHouse"),
    ("nginx", None, "nginx"),
    ("ollama/ollama", Some(Category::Ai), "Ollama"),
    ("ollama", Some(Category::Ai), "Ollama"),
];

/// The category and framework of a port published by a container running `image` (WP-20). A
/// known repository names the product and, for a store or a model server, its category; an
/// unknown one is named as it is, without the tag, and the port decides the category as it
/// does for any other process.
pub fn classify_container(port: u16, protocol: Protocol, image: &str) -> (Category, String) {
    let repository = image_repository(image);
    let short = repository.strip_prefix("docker.io/").unwrap_or(&repository);
    let short = short.strip_prefix("library/").unwrap_or(short);
    let last = short.rsplit('/').next().unwrap_or(short);
    let hit = BY_IMAGE.iter().find(|(key, _, _)| *key == short).or_else(|| BY_IMAGE.iter().find(|(key, _, _)| *key == last));
    let by_port = by_port(port, protocol).map_or(Category::Other, |(category, _)| category);
    match hit {
        Some((_, category, framework)) => (category.unwrap_or(by_port), (*framework).to_string()),
        None => (by_port, repository),
    }
}

/// `postgres:16` → `postgres`; `ghcr.io/acme/api:1.2` → `ghcr.io/acme/api`; a digest
/// (`redis@sha256:…`) goes too. A `:` before the last `/` is a registry port, not a tag.
fn image_repository(image: &str) -> String {
    let image = image.trim();
    let without_digest = image.split_once('@').map_or(image, |(repo, _)| repo);
    let last_slash = without_digest.rfind('/').map_or(0, |i| i + 1);
    match without_digest[last_slash..].rfind(':') {
        Some(colon) => without_digest[..last_slash + colon].to_string(),
        None => without_digest.to_string(),
    }
}

/// `subject` is `needle`, or starts with it and goes on with something that is not part of a
/// name: `redis-server` is `redis`, `postgres_exporter` is not `postgres`.
fn named(subject: &str, needle: &str) -> bool {
    subject.strip_prefix(needle).is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
}

fn is_system_path(exe: &str) -> bool {
    SYSTEM_PREFIXES.iter().any(|prefix| Path::new(exe).starts_with(prefix))
}

/// What a port number says by convention, when the process said nothing. The system ports speak
/// UDP too (DNS, printing); the rest describe TCP servers, so a UDP socket on 3000 is not a web
/// app. 5000 is an API unless Control Center holds it, which the name rule above decides.
fn by_port(port: u16, protocol: Protocol) -> Option<(Category, Option<&'static str>)> {
    let system = match port {
        53 => Some("DNS"),
        631 => Some("CUPS"),
        7000 => Some("AirPlay"),
        _ => None,
    };
    if let Some(framework) = system {
        return Some((Category::System, Some(framework)));
    }
    if protocol != Protocol::Tcp {
        return None;
    }
    let hit = match port {
        3000..=3010 | 5173..=5199 | 4200 | 4321 | 8081 => (Category::Web, None),
        8000 | 8080 | 5000 | 4000 | 9000 => (Category::Api, None),
        5432 => (Category::Db, Some("PostgreSQL")),
        3306 => (Category::Db, Some("MySQL")),
        27017 => (Category::Db, Some("MongoDB")),
        6379 => (Category::Db, Some("Redis")),
        9200 => (Category::Db, Some("Elasticsearch")),
        8123 => (Category::Db, Some("ClickHouse")),
        5984 => (Category::Db, Some("CouchDB")),
        11434 => (Category::Ai, Some("Ollama")),
        1234 => (Category::Ai, Some("LM Studio")),
        8001 => (Category::Ai, None),
        _ => return None,
    };
    Some(hit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Category::*;

    /// One row of the table: the inputs and what they must classify as.
    struct Case {
        port: u16,
        protocol: Protocol,
        tool: Option<&'static str>,
        name: &'static str,
        exe: Option<&'static str>,
        command: &'static str,
        expected: (Category, Option<&'static str>),
    }

    const fn tcp(
        port: u16,
        tool: Option<&'static str>,
        name: &'static str,
        exe: Option<&'static str>,
        command: &'static str,
        expected: (Category, Option<&'static str>),
    ) -> Case {
        Case { port, protocol: Protocol::Tcp, tool, name, exe, command, expected }
    }

    const fn udp(
        port: u16,
        name: &'static str,
        exe: Option<&'static str>,
        expected: (Category, Option<&'static str>),
    ) -> Case {
        Case { port, protocol: Protocol::Udp, tool: None, name, exe, command: "", expected }
    }

    const NODE: Option<&str> = Some("/opt/homebrew/bin/node");
    const PY: Option<&str> = Some("/opt/homebrew/bin/python3");
    const CC: Option<&str> = Some("/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter");
    const DOCKER: Option<&str> = Some("/Applications/Docker.app/Contents/MacOS/com.docker.backend");

    #[test]
    fn classification_table() {
        let cases = [
            // by tool: the tool wins over the port
            tcp(3000, Some("next"), "node", NODE, "node /w/shop/node_modules/.bin/next dev", (Web, Some("Next.js"))),
            tcp(8080, Some("next"), "next-server (v15)", NODE, "next-server", (Web, Some("Next.js"))),
            tcp(5173, Some("vite"), "node", NODE, "node /w/pr/node_modules/.bin/vite", (Web, Some("Vite"))),
            tcp(3000, Some("nuxt"), "node", NODE, "nuxt dev", (Web, Some("Nuxt"))),
            tcp(4321, Some("astro"), "node", NODE, "astro dev", (Web, Some("Astro"))),
            tcp(6006, Some("storybook"), "node", NODE, "storybook dev", (Web, Some("Storybook"))),
            tcp(8080, Some("nest"), "node", NODE, "node /w/api/node_modules/@nestjs/cli/bin/nest.js start", (Api, Some("NestJS"))),
            tcp(8000, Some("uvicorn"), "python3", PY, "/venv/bin/python -m uvicorn app:main", (Api, Some("FastAPI"))),
            tcp(8000, Some("gunicorn"), "gunicorn", PY, "gunicorn shop.wsgi", (Api, Some("Django"))),
            tcp(5000, Some("flask"), "python3", PY, "flask run", (Api, Some("Flask"))),
            tcp(3000, Some("rails"), "ruby", Some("/opt/homebrew/bin/ruby"), "rails server", (Api, Some("Rails"))),
            tcp(3000, Some("go"), "api", Some("/w/api/api"), "/usr/local/go/bin/go run ./cmd/api", (Api, Some("Go"))),
            // express is read from the command line, as a token
            tcp(3000, Some("node"), "node", NODE, "node express-app.js", (Api, Some("Express"))),
            tcp(3000, Some("node"), "node", NODE, "node /w/expressive-ui/server.js", (Web, None)),
            // by name, wherever it listens
            tcp(5432, Some("postgres"), "postgres", Some("/opt/homebrew/opt/postgresql@16/bin/postgres"), "postgres -D /data", (Db, Some("PostgreSQL"))),
            tcp(5433, None, "postgres", None, "", (Db, Some("PostgreSQL"))),
            tcp(3306, Some("mysql"), "mysqld", Some("/opt/homebrew/opt/mysql/bin/mysqld"), "mysqld", (Db, Some("MySQL"))),
            tcp(27017, Some("mongod"), "mongod", None, "mongod", (Db, Some("MongoDB"))),
            tcp(3000, None, "redis-server", Some("/Users/amit/.local/bin/redis-server"), "", (Db, Some("Redis"))),
            tcp(9000, None, "clickhouse-server", Some("/opt/homebrew/bin/clickhouse-server"), "", (Db, Some("ClickHouse"))),
            tcp(3000, None, "postgres_exporter", None, "", (Web, None)),
            tcp(11434, None, "ollama", Some("/Applications/Ollama.app/Contents/Resources/ollama"), "ollama serve", (Ai, Some("Ollama"))),
            tcp(1234, None, "LM Studio", Some("/Applications/LM Studio.app/Contents/MacOS/LM Studio"), "", (Ai, Some("LM Studio"))),
            tcp(8000, None, "vllm", None, "", (Ai, Some("vLLM"))),
            tcp(8080, None, "llama-server", Some("/opt/llama.cpp/bin/llama-server"), "", (Ai, Some("llama.cpp"))),
            // system: by path, by name, by port
            tcp(7000, None, "ControlCenter", CC, "", (System, Some("AirPlay"))),
            tcp(5000, None, "ControlCenter", None, "", (System, Some("AirPlay"))),
            tcp(5000, Some("python"), "python3", PY, "python3 -m http.server 5000", (Api, None)),
            udp(53, "mDNSResponder", Some("/usr/sbin/mDNSResponder"), (System, Some("mDNS"))),
            udp(53, "", None, (System, Some("DNS"))),
            tcp(631, None, "cupsd", Some("/usr/sbin/cupsd"), "", (System, Some("CUPS"))),
            tcp(22, None, "sshd", Some("/usr/sbin/sshd"), "", (System, Some("SSH"))),
            tcp(49152, None, "rapportd", Some("/usr/libexec/rapportd"), "", (System, None)),
            tcp(3000, Some("node"), "node", Some("/usr/bin/node"), "node server.js", (System, None)),
            // by port
            tcp(5432, Some("docker"), "com.docker.backend", DOCKER, "", (Db, Some("PostgreSQL"))),
            tcp(6379, Some("docker"), "com.docker.backend", DOCKER, "", (Db, Some("Redis"))),
            tcp(5432, None, "", None, "", (Db, Some("PostgreSQL"))),
            tcp(9200, Some("java"), "java", Some("/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java"), "java -jar es.jar", (Db, Some("Elasticsearch"))),
            tcp(8123, None, "", None, "", (Db, Some("ClickHouse"))),
            tcp(5984, None, "", None, "", (Db, Some("CouchDB"))),
            tcp(3005, Some("node"), "node", NODE, "node server.js", (Web, None)),
            tcp(5199, Some("node"), "node", NODE, "node server.js", (Web, None)),
            tcp(5200, Some("node"), "node", NODE, "node server.js", (Other, None)),
            tcp(4200, Some("node"), "node", NODE, "ng serve", (Web, None)),
            tcp(8081, Some("node"), "node", NODE, "node metro", (Web, None)),
            tcp(8080, Some("java"), "java", Some("/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java"), "java -jar app.jar", (Api, None)),
            tcp(4000, Some("node"), "node", NODE, "node dist/main.js", (Api, None)),
            tcp(11434, None, "", None, "", (Ai, Some("Ollama"))),
            tcp(8001, Some("python"), "python3", PY, "python3 serve.py", (Ai, None)),
            // nothing says what it is
            tcp(9335, None, "chrome-helper", Some("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/chrome_crashpad_handler"), "", (Other, None)),
            tcp(49200, Some("node"), "node", NODE, "node server.js", (Other, None)),
            udp(3000, "node", NODE, (Other, None)),
            udp(5353, "sharingd", Some("/usr/libexec/sharingd"), (System, None)),
        ];
        assert!(cases.len() >= 25);
        for case in &cases {
            let (category, framework) =
                classify(case.port, case.protocol, case.tool, case.name, case.exe, case.command);
            assert_eq!(
                (category, framework.as_deref()),
                case.expected,
                "port {} {:?} tool {:?} name {:?} exe {:?} command {:?}",
                case.port,
                case.protocol,
                case.tool,
                case.name,
                case.exe,
                case.command
            );
        }
    }

    #[test]
    fn a_db_port_is_db_even_when_the_process_is_unknown() {
        // Another user's process: no name, no exe, no tool. The port still says "database", and
        // `ports.rs` makes that protected.
        for port in [5432, 3306, 27017, 6379, 9200, 8123, 5984] {
            let (category, _) = classify(port, Protocol::Tcp, None, "", None, "");
            assert_eq!(category, Db, "port {port}");
        }
    }

    #[test]
    fn image_table() {
        let cases: &[(u16, &str, (Category, &str))] = &[
            // the stores: the product names the framework and the category, wherever the port
            (5432, "postgres:16", (Db, "PostgreSQL")),
            (5433, "postgres", (Db, "PostgreSQL")),
            (15432, "docker.io/library/postgres:16-alpine", (Db, "PostgreSQL")),
            (5432, "bitnami/postgresql:16", (Db, "PostgreSQL")),
            (5432, "postgres@sha256:0123abcd", (Db, "PostgreSQL")),
            (6380, "redis:7", (Db, "Redis")),
            (27018, "mongo:7", (Db, "MongoDB")),
            (3307, "mysql:8", (Db, "MySQL")),
            (3306, "mariadb:11", (Db, "MariaDB")),
            (5672, "rabbitmq:3-management", (Db, "RabbitMQ")),
            (9200, "elasticsearch:8.12.0", (Db, "Elasticsearch")),
            (9200, "docker.elastic.co/elasticsearch/elasticsearch:8.12.0", (Db, "Elasticsearch")),
            (8123, "clickhouse/clickhouse-server:24", (Db, "ClickHouse")),
            // model servers
            (11434, "ollama/ollama", (Ai, "Ollama")),
            (11435, "ollama/ollama:0.3", (Ai, "Ollama")),
            // named, but the port decides the category
            (8080, "nginx:1.25", (Api, "nginx")),
            (80, "nginx", (Other, "nginx")),
            // unknown: the repository as is, without the tag or digest, and the port rule
            (8080, "ghcr.io/acme/shop-api:latest", (Api, "ghcr.io/acme/shop-api")),
            (3000, "acme/shop-web:1.2.3", (Web, "acme/shop-web")),
            (5432, "timescale/timescaledb-ha:pg16", (Db, "timescale/timescaledb-ha")),
            (49200, "busybox", (Other, "busybox")),
            (49200, "localhost:5000/acme/tool:dev", (Other, "localhost:5000/acme/tool")),
            (49200, "localhost:5000/acme/tool", (Other, "localhost:5000/acme/tool")),
        ];
        for (port, image, expected) in cases {
            let (category, framework) = classify_container(*port, Protocol::Tcp, image);
            assert_eq!((category, framework.as_str()), *expected, "port {port} image {image:?}");
        }
        // UDP keeps the port rule's silence outside the system ports.
        assert_eq!(classify_container(3000, Protocol::Udp, "acme/app"), (Other, "acme/app".into()));
        assert_eq!(classify_container(53, Protocol::Udp, "coredns/coredns:1.11"), (System, "coredns/coredns".into()));
    }

    #[test]
    fn image_repository_strips_the_tag_and_the_digest_but_not_a_registry_port() {
        assert_eq!(image_repository("postgres:16"), "postgres");
        assert_eq!(image_repository("postgres"), "postgres");
        assert_eq!(image_repository("ghcr.io/acme/api:1.2"), "ghcr.io/acme/api");
        assert_eq!(image_repository("redis@sha256:abc"), "redis");
        assert_eq!(image_repository("redis:7@sha256:abc"), "redis");
        assert_eq!(image_repository("localhost:5000/acme/tool"), "localhost:5000/acme/tool");
        assert_eq!(image_repository("localhost:5000/acme/tool:dev"), "localhost:5000/acme/tool");
        assert_eq!(image_repository("  nginx:latest  "), "nginx");
    }

    #[test]
    fn named_is_a_token_match() {
        assert!(named("redis-server", "redis"));
        assert!(named("postgres", "postgres"));
        assert!(named("lm studio helper", "lm studio"));
        assert!(!named("postgres_exporter", "postgres"));
        assert!(!named("postgresql", "postgres"), "handled by its own needle");
        assert!(!named("nextcloud", "next"));
        assert!(!named("gopls", "go"));
        assert!(!named("", "go"));
    }
}
