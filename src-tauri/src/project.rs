//! Project detection: from a process's working directory to "shop-api on feature/cart".
//!
//! Owned by WP-2. Pure functions over the filesystem, no subprocesses: the branch is read from
//! `.git/HEAD`, never from `git` itself, so a scan of forty processes stays under a few
//! milliseconds and works with no git on PATH.
//!
//! The one rule above all: when unsure, return `None`. A port under the wrong project is worse
//! than no project, so every step here prefers giving up over guessing.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::model::{ProjectInfo, ProjectKind};

/// How many directories a walk visits, the start included: twelve levels up. Deep enough for any
/// real checkout, shallow enough that a stray cwd somewhere odd costs nothing.
const MAX_WALK: usize = 13;

/// A manifest larger than this is not read. Only `package.json` can grow, and a name is never
/// that far in.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

/// Directories that hold project-local installs. An executable below one of these belongs to the
/// project above it, never to the dependency that ships it. One that lives anywhere else
/// (`~/.nvm`, `~/.pyenv`, Homebrew, `~/.cargo/bin`) says nothing about a project: `~/.nvm` is
/// itself a git clone with a `package.json`, and naming it would be exactly the wrong project.
const LOCAL_INSTALL_DIRS: &[&str] = &["node_modules", "target", ".venv", "venv"];

/// Command-line patterns and the tool they name. First hit wins, so the specific comes before the
/// generic: `vite` before `node`, `uvicorn` before `python`, `com.docker` before `docker`.
const TOOLS: &[(&str, &str)] = &[
    ("vite", "vite"),
    ("next", "next"),
    ("nuxt", "nuxt"),
    ("nest", "nest"),
    ("remix", "remix"),
    ("astro", "astro"),
    ("storybook", "storybook"),
    ("webpack", "webpack"),
    ("vitest", "vitest"),
    ("jest", "jest"),
    ("playwright", "playwright"),
    ("tsx", "tsx"),
    ("ts-node", "ts-node"),
    ("bun", "bun"),
    ("deno", "deno"),
    ("node", "node"),
    ("uvicorn", "uvicorn"),
    ("gunicorn", "gunicorn"),
    ("flask", "flask"),
    ("django", "django"),
    ("python", "python"),
    ("cargo", "cargo"),
    ("target/debug", "cargo"),
    ("target/release", "cargo"),
    ("go ", "go"),
    ("com.docker", "docker"),
    ("docker", "docker"),
    ("postgres", "postgres"),
    ("redis", "redis"),
    ("mysqld", "mysql"),
    ("mysql", "mysql"),
    ("mongod", "mongod"),
    ("java", "java"),
    ("rails", "rails"),
    ("ruby", "ruby"),
    ("php", "php"),
];

/// Finds the project a process belongs to.
///
/// `cwd` is the process's working directory when the OS reports it; `exe` is its executable path,
/// used as a fallback (a globally installed CLI run from `~` has no useful cwd); `command` is the
/// full command line, used to name the tool (`vite`, `next dev`, `nest start`...).
pub fn detect(cwd: Option<&Path>, exe: Option<&Path>, command: &str) -> Option<ProjectInfo> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    detect_in(cwd, exe, command, home.as_deref())
}

/// `detect` with the home directory as a parameter, so tests can make one up.
pub(crate) fn detect_in(cwd: Option<&Path>, exe: Option<&Path>, command: &str, home: Option<&Path>) -> Option<ProjectInfo> {
    let start = start_dir(cwd, exe, home)?;
    let (root, kind) = find_root(&start, home)?;
    Some(ProjectInfo {
        name: read_name(&root, kind),
        root: root.to_string_lossy().into_owned(),
        kind,
        branch: read_branch(&root, home),
        tool: detect_tool(command),
    })
}

/// Where the walk begins: the working directory when it says something, else the project-local
/// install the executable lives in, else nowhere.
fn start_dir(cwd: Option<&Path>, exe: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(cwd) = cwd {
        // A cwd inside node_modules belongs to the project above it, not to the dependency.
        let cwd = above_local_install(cwd).unwrap_or_else(|| cwd.to_path_buf());
        if usable_start(&cwd, home) {
            return Some(cwd);
        }
    }
    let start = above_local_install(exe?)?;
    usable_start(&start, home).then_some(start)
}

/// `/` and the home directory are never a project, and neither is a directory that is gone.
fn usable_start(dir: &Path, home: Option<&Path>) -> bool {
    dir.parent().is_some() && Some(dir) != home && dir.is_dir()
}

/// The path above the first project-local install directory in `path`, if there is one.
fn above_local_install(path: &Path) -> Option<PathBuf> {
    let mut above = PathBuf::new();
    for component in path.components() {
        if let Component::Normal(name) = component {
            if name.to_str().is_some_and(|name| LOCAL_INSTALL_DIRS.contains(&name)) {
                return Some(above);
            }
        }
        above.push(component);
    }
    None
}

/// `start` and its ancestors, at most `MAX_WALK` of them, never reaching the home directory or
/// `/`: a `package.json` (or a dotfiles `.git`) in `$HOME` is not a project.
fn walk<'a>(start: &'a Path, home: Option<&'a Path>) -> impl Iterator<Item = &'a Path> + 'a {
    start.ancestors().take(MAX_WALK).take_while(move |dir| dir.parent().is_some() && Some(*dir) != home)
}

/// The nearest directory at or above `start` that holds a manifest, with the kind it implies.
/// In a monorepo the nearest manifest wins: `apps/api/package.json` over the one at the top.
pub(crate) fn find_root(start: &Path, home: Option<&Path>) -> Option<(PathBuf, ProjectKind)> {
    walk(start, home).find_map(|dir| kind_of(dir).map(|kind| (dir.to_path_buf(), kind)))
}

/// The kind of project rooted at `dir`, by its manifest. Within one directory the package
/// manifest wins over the `.git` beside it.
fn kind_of(dir: &Path) -> Option<ProjectKind> {
    const MANIFESTS: &[(&str, ProjectKind)] = &[
        ("package.json", ProjectKind::Node),
        ("Cargo.toml", ProjectKind::Rust),
        ("pyproject.toml", ProjectKind::Python),
        ("requirements.txt", ProjectKind::Python),
        ("go.mod", ProjectKind::Go),
        (".git", ProjectKind::Git),
    ];
    MANIFESTS.iter().find(|(file, _)| dir.join(file).exists()).map(|(_, kind)| *kind)
}

/// The project's name from its manifest, else the folder name. A manifest that cannot be parsed
/// is treated as one without a name.
pub(crate) fn read_name(root: &Path, kind: ProjectKind) -> String {
    let from_manifest = match kind {
        ProjectKind::Node => read_small(&root.join("package.json")).and_then(|json| package_json_name(&json)),
        ProjectKind::Rust => read_small(&root.join("Cargo.toml")).and_then(|toml| toml_name(&toml, &["package"])),
        ProjectKind::Python => {
            read_small(&root.join("pyproject.toml")).and_then(|toml| toml_name(&toml, &["project", "tool.poetry"]))
        }
        ProjectKind::Go => read_small(&root.join("go.mod")).and_then(|gomod| go_mod_name(&gomod)),
        ProjectKind::Git | ProjectKind::Unknown => None,
    };
    from_manifest.unwrap_or_else(|| folder_name(root))
}

fn folder_name(root: &Path) -> String {
    match root.file_name() {
        Some(name) => name.to_string_lossy().into_owned(),
        None => root.to_string_lossy().into_owned(),
    }
}

/// Reads a manifest, refusing anything over `MAX_MANIFEST_BYTES` or not UTF-8.
fn read_small(path: &Path) -> Option<String> {
    if fs::metadata(path).ok()?.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn package_json_name(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    non_empty(value.get("name")?.as_str()?)
}

/// `name = "..."` from one of `sections` of a TOML file, by line scanning. Enough for the
/// manifests we read, and no TOML crate in the binary. Stops at the first `name` key in a wanted
/// section: if that one is not a plain quoted string, the manifest is odd and we do not guess.
fn toml_name(toml: &str, sections: &[&str]) -> Option<String> {
    let mut in_wanted_section = false;
    for line in toml.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[') {
            // `[[bin]]` becomes `bin`, `[package] # note` becomes `package`.
            let section = header.trim_start_matches('[').split(']').next().unwrap_or("").trim();
            in_wanted_section = sections.contains(&section);
        } else if in_wanted_section {
            let value = line.strip_prefix("name").map(str::trim_start).and_then(|rest| rest.strip_prefix('='));
            if let Some(value) = value {
                return quoted(value);
            }
        }
    }
    None
}

/// The content of the TOML basic or literal string that `value` starts with.
fn quoted(value: &str) -> Option<String> {
    let value = value.trim_start();
    let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let (inner, _) = value[1..].split_once(quote)?;
    non_empty(inner)
}

/// The last segment of the `module` path, skipping a major-version suffix: `example.com/shop/v2`
/// is `shop`, not `v2`.
fn go_mod_name(gomod: &str) -> Option<String> {
    let module = gomod.lines().map(str::trim).find_map(|line| line.strip_prefix("module "))?;
    let mut segments = module.trim().trim_matches('"').split('/').rev().filter(|s| !s.is_empty());
    let last = segments.next()?;
    let name = if is_major_version(last) { segments.next().unwrap_or(last) } else { last };
    non_empty(name)
}

fn is_major_version(segment: &str) -> bool {
    segment.strip_prefix('v').is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn non_empty(name: &str) -> Option<String> {
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// The checked-out branch of the repository holding `root`, read from `.git/HEAD`. A `.git`
/// that is a file is a worktree (or a submodule): it names the real git directory, and that
/// one's `HEAD` is the worktree's own. Detached: the first 7 characters of the sha.
pub(crate) fn read_branch(root: &Path, home: Option<&Path>) -> Option<String> {
    let dot_git = walk(root, home).map(|dir| dir.join(".git")).find(|path| path.exists())?;
    let git_dir = if dot_git.is_dir() { dot_git } else { linked_git_dir(&dot_git)? };
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    branch_from_head(&head)
}

/// Follows the `gitdir: <path>` line of a `.git` file. A relative path is relative to the file's
/// folder, which is how submodules write it; worktrees write an absolute one.
fn linked_git_dir(dot_git: &Path) -> Option<PathBuf> {
    let content = read_small(dot_git)?;
    let target = Path::new(content.lines().find_map(|line| line.strip_prefix("gitdir:"))?.trim());
    if target.is_absolute() {
        Some(target.to_path_buf())
    } else {
        Some(dot_git.parent()?.join(target))
    }
}

fn branch_from_head(head: &str) -> Option<String> {
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref:") {
        return reference.trim().strip_prefix("refs/heads/").and_then(non_empty);
    }
    let is_sha = (head.len() == 40 || head.len() == 64) && head.bytes().all(|b| b.is_ascii_hexdigit());
    is_sha.then(|| head[..7].to_string())
}

/// The tool a command line runs, from the first `TOOLS` pattern that occurs in it as a token.
pub(crate) fn detect_tool(command: &str) -> Option<String> {
    let command = command.to_ascii_lowercase();
    TOOLS.iter().find(|(pattern, _)| occurs_as_token(&command, pattern)).map(|(_, tool)| (*tool).to_string())
}

/// `pattern` occurs in `haystack` as a word or path segment, not as part of a longer name:
/// `node_modules/.bin/vite` is `vite` and not `node`, `src/app.tsx` is not `tsx`, `javac` is not
/// `java`. A digit after the pattern is fine (`python3`), and so is a dash (`redis-server`).
/// `classify` uses the same rule to read a command line, so both agree on what a token is.
pub(crate) fn occurs_as_token(haystack: &str, pattern: &str) -> bool {
    let bytes = haystack.as_bytes();
    let glued_before = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'.';
    let glued_after = |c: u8| c.is_ascii_alphabetic() || c == b'_';
    // A pattern that ends in a separator (`go `) carries its own boundary.
    let check_after = pattern.as_bytes().last().is_some_and(|c| c.is_ascii_alphanumeric());
    haystack.match_indices(pattern).any(|(start, _)| {
        let end = start + pattern.len();
        let free_before = start == 0 || !glued_before(bytes[start - 1]);
        let free_after = !check_after || end == bytes.len() || !glued_after(bytes[end]);
        free_before && free_after
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use tempfile::TempDir;

    use super::*;

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn dir(path: &Path) -> PathBuf {
        fs::create_dir_all(path).unwrap();
        path.to_path_buf()
    }

    fn detect_at(cwd: &Path, command: &str) -> Option<ProjectInfo> {
        detect_in(Some(cwd), None, command, None)
    }

    fn lossy(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn node_monorepo_sub_package() {
        let tmp = TempDir::new().unwrap();
        let top = tmp.path();
        write(&top.join(".git/HEAD"), "ref: refs/heads/feature/cart\n");
        write(&top.join("package.json"), r#"{ "name": "shop", "private": true }"#);
        write(&top.join("apps/api/package.json"), r#"{ "name": "@shop/api", "version": "1.0.0" }"#);
        let cwd = dir(&top.join("apps/api/src"));

        let info = detect_at(&cwd, "node dist/main.js").unwrap();

        assert_eq!(
            info,
            ProjectInfo {
                name: "@shop/api".into(),
                root: lossy(&top.join("apps/api")),
                kind: ProjectKind::Node,
                branch: Some("feature/cart".into()),
                tool: Some("node".into()),
            }
        );
    }

    #[test]
    fn worktree_git_file() {
        let tmp = TempDir::new().unwrap();
        let main = tmp.path().join("main");
        let worktree = tmp.path().join("wt");
        write(&main.join(".git/HEAD"), "ref: refs/heads/main\n");
        write(&main.join(".git/worktrees/wt/HEAD"), "ref: refs/heads/feature/wt\n");
        write(&main.join("package.json"), r#"{ "name": "shop" }"#);
        write(&worktree.join(".git"), &format!("gitdir: {}\n", main.join(".git/worktrees/wt").display()));
        write(&worktree.join("package.json"), r#"{ "name": "shop" }"#);
        let cwd = dir(&worktree.join("src"));

        let info = detect_at(&cwd, "vite").unwrap();
        assert_eq!(info.branch.as_deref(), Some("feature/wt"));
        assert_eq!(info.root, lossy(&worktree));
        assert_eq!(detect_at(&main, "vite").unwrap().branch.as_deref(), Some("main"));

        // Submodules write the gitdir relative to the `.git` file.
        write(&worktree.join(".git"), "gitdir: ../main/.git/worktrees/wt\n");
        assert_eq!(read_branch(&worktree, None).as_deref(), Some("feature/wt"));

        // A `.git` file we cannot follow is a project without a branch, not no project.
        write(&worktree.join(".git"), "not a gitdir line\n");
        let info = detect_at(&cwd, "vite").unwrap();
        assert_eq!(info.name, "shop");
        assert_eq!(info.branch, None);
    }

    #[test]
    fn detached_head() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(&root.join("package.json"), r#"{ "name": "shop" }"#);
        write(&root.join(".git/HEAD"), "3f2a9b1c4d5e6f708192a3b4c5d6e7f8091a2b3c\n");
        assert_eq!(detect_at(root, "node").unwrap().branch.as_deref(), Some("3f2a9b1"));

        for odd in ["ref: refs/remotes/origin/main\n", "ref: refs/heads/\n", "garbage\n", "3f2a9b1\n", ""] {
            write(&root.join(".git/HEAD"), odd);
            let info = detect_at(root, "node").unwrap();
            assert_eq!(info.branch, None, "HEAD {odd:?} must not name a branch");
            assert_eq!(info.name, "shop");
        }

        fs::remove_file(root.join(".git/HEAD")).unwrap();
        assert_eq!(detect_at(root, "node").unwrap().branch, None);
    }

    #[test]
    fn cargo_project() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("app");
        write(
            &root.join("Cargo.toml"),
            "[package]\nname = \"portreaper\" # the crate\nversion = \"0.1.0\"\n\n[[bin]]\nname = \"pr\"\n\n[dependencies]\nserde = \"1\"\n",
        );
        let cwd = dir(&root.join("src"));

        let info = detect_at(&cwd, "target/debug/portreaper").unwrap();
        assert_eq!((info.name.as_str(), info.kind), ("portreaper", ProjectKind::Rust));
        assert_eq!(info.root, lossy(&root));
        assert_eq!(info.tool.as_deref(), Some("cargo"));

        // A workspace root has no package of its own; the nearest crate's name wins below it.
        write(&root.join("Cargo.toml"), "[workspace]\nmembers = [\"crates/*\"]\n\n[workspace.package]\nname = \"nope\"\n");
        assert_eq!(detect_at(&cwd, "cargo run").unwrap().name, "app");
    }

    #[test]
    fn python_and_go() {
        let tmp = TempDir::new().unwrap();

        let pep621 = tmp.path().join("pep621");
        write(&pep621.join("pyproject.toml"), "[build-system]\nrequires = [\"hatchling\"]\n\n[project]\nname = \"shop-api\"\n");
        let info = detect_at(&pep621, "/venv/bin/python -m uvicorn app:main").unwrap();
        assert_eq!((info.name.as_str(), info.kind), ("shop-api", ProjectKind::Python));
        assert_eq!(info.tool.as_deref(), Some("uvicorn"));

        let poetry = tmp.path().join("poetry");
        write(&poetry.join("pyproject.toml"), "[tool.poetry]\nname = 'poetry-app'\n\n[tool.poetry.dependencies]\nname = \"not-this\"\n");
        assert_eq!(detect_at(&poetry, "python").unwrap().name, "poetry-app");

        let bare = tmp.path().join("bare");
        write(&bare.join("requirements.txt"), "flask\n");
        let info = detect_at(&bare, "flask run").unwrap();
        assert_eq!((info.name.as_str(), info.kind), ("bare", ProjectKind::Python));

        let go = tmp.path().join("go-svc");
        write(&go.join("go.mod"), "module github.com/amit/shop-api\n\ngo 1.22\n");
        let info = detect_at(&dir(&go.join("cmd/api")), "/usr/local/go/bin/go run ./cmd/api").unwrap();
        assert_eq!((info.name.as_str(), info.kind), ("shop-api", ProjectKind::Go));
        assert_eq!(info.tool.as_deref(), Some("go"));

        write(&go.join("go.mod"), "module github.com/amit/shop-api/v2\n");
        assert_eq!(detect_at(&go, "").unwrap().name, "shop-api");
    }

    #[test]
    fn git_only() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("notes");
        write(&root.join(".git/HEAD"), "ref: refs/heads/main\n");
        let cwd = dir(&root.join("drafts"));

        let info = detect_at(&cwd, "/some/unknown-daemon").unwrap();

        assert_eq!(
            info,
            ProjectInfo { name: "notes".into(), root: lossy(&root), kind: ProjectKind::Git, branch: Some("main".into()), tool: None }
        );
    }

    #[test]
    fn home_is_not_a_project() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join("package.json"), r#"{ "name": "home" }"#);
        write(&home.join(".git/HEAD"), "ref: refs/heads/dotfiles\n");

        assert_eq!(detect_in(Some(home), None, "node", Some(home)), None);
        let desktop = dir(&home.join("Desktop"));
        assert_eq!(detect_in(Some(&desktop), None, "node", Some(home)), None);

        // A project inside home is found, but the dotfiles repository above it lends no branch.
        let app = home.join("work/app");
        write(&app.join("package.json"), r#"{ "name": "app" }"#);
        let info = detect_in(Some(&app), None, "node", Some(home)).unwrap();
        assert_eq!(info.name, "app");
        assert_eq!(info.branch, None);

        // The same tree with a different home is a project with a branch: only `home` stops the walk.
        let info = detect_in(Some(&app), None, "node", None).unwrap();
        assert_eq!(info.branch.as_deref(), Some("dotfiles"));
    }

    #[test]
    fn exe_fallback() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("shop");
        write(&root.join("package.json"), r#"{ "name": "shop" }"#);
        write(&root.join("node_modules/@esbuild/darwin-arm64/package.json"), r#"{ "name": "@esbuild/darwin-arm64" }"#);

        let exe = root.join("node_modules/.bin/vite");
        let info = detect_in(None, Some(&exe), "node_modules/.bin/vite", None).unwrap();
        assert_eq!((info.name.as_str(), info.root.as_str()), ("shop", lossy(&root).as_str()));
        assert_eq!(info.tool.as_deref(), Some("vite"));

        // A cwd that is gone (or `/`) falls back to the exe too.
        let gone = tmp.path().join("gone");
        assert_eq!(detect_in(Some(&gone), Some(&exe), "vite", None).unwrap().name, "shop");
        assert_eq!(detect_in(Some(Path::new("/")), Some(&exe), "vite", None).unwrap().name, "shop");

        // A binary shipped by a dependency belongs to the project, not to the dependency.
        let nested = root.join("node_modules/@esbuild/darwin-arm64/bin/esbuild");
        assert_eq!(detect_in(None, Some(&nested), "esbuild", None).unwrap().name, "shop");

        // A global install says nothing, even when a manifest sits above it (`~/.nvm` is one).
        let nvm = tmp.path().join(".nvm");
        write(&nvm.join("package.json"), r#"{ "name": "nvm" }"#);
        let global = dir(&nvm.join("versions/node/v24.0.0/bin")).join("node");
        assert_eq!(detect_in(None, Some(&global), "node server.js", None), None);
        assert_eq!(detect_in(None, None, "node server.js", None), None);
    }

    #[test]
    fn tool_table() {
        let cases: &[(&str, Option<&str>)] = &[
            ("node_modules/.bin/vite", Some("vite")),
            ("node /app/node_modules/.bin/../vite/bin/vite.js --host", Some("vite")),
            ("node /app/node_modules/.bin/vitest run", Some("vitest")),
            ("node /app/node_modules/next/dist/bin/next dev", Some("next")),
            ("node /app/node_modules/@nestjs/cli/bin/nest.js start --watch", Some("nest")),
            ("/app/node_modules/.bin/tsx watch src/index.ts", Some("tsx")),
            ("ts-node src/server.ts", Some("ts-node")),
            ("node dist/main.js", Some("node")),
            ("node dist/server.js --entry src/app.tsx", Some("node")),
            ("bun run dev", Some("bun")),
            ("/opt/homebrew/bin/python3.12 manage.py runserver", Some("python")),
            ("/venv/bin/python -m uvicorn app:main", Some("uvicorn")),
            ("/usr/local/go/bin/go run ./cmd/api", Some("go")),
            ("./server main.go", None),
            ("cargo run --bin api", Some("cargo")),
            ("/Users/amit/work/pr/target/debug/portreaper", Some("cargo")),
            ("/Applications/Docker.app/Contents/MacOS/com.docker.backend", Some("docker")),
            ("postgres -D /data", Some("postgres")),
            ("redis-server *:6379", Some("redis")),
            ("/opt/homebrew/opt/mysql/bin/mysqld --datadir=/opt/homebrew/var/mysql", Some("mysql")),
            ("/usr/bin/java -jar app.jar", Some("java")),
            ("/usr/libexec/java_home", None),
            ("/some/unknown-daemon --port 8080", None),
            ("", None),
        ];
        for (command, expected) in cases {
            assert_eq!(detect_tool(command).as_deref(), *expected, "command {command:?}");
        }
    }

    #[test]
    fn walks_at_most_12_levels() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("deep");
        write(&root.join("package.json"), r#"{ "name": "deep" }"#);

        let twelve = dir(&root.join("1/2/3/4/5/6/7/8/9/10/11/12"));
        assert_eq!(detect_at(&twelve, "node").unwrap().name, "deep");

        let fourteen = dir(&root.join("1/2/3/4/5/6/7/8/9/10/11/12/13/14"));
        assert_eq!(detect_at(&fourteen, "node"), None);
    }

    #[test]
    fn broken_package_json_names_the_folder() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("shop");
        for content in [r#"{ "name": "shop", "#, "{}", r#"{ "name": "" }"#, r#"{ "name": 42 }"#] {
            write(&root.join("package.json"), content);
            let info = detect_at(&root, "node").unwrap();
            assert_eq!((info.name.as_str(), info.kind), ("shop", ProjectKind::Node), "package.json {content:?}");
        }

        // Too big to be a manifest we trust, even if it would parse.
        let huge = format!("{{ \"name\": \"big\", \"pad\": \"{}\" }}", "x".repeat(70 * 1024));
        write(&root.join("package.json"), &huge);
        assert_eq!(detect_at(&root, "node").unwrap().name, "shop");
    }
}
