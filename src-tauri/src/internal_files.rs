//! Files are discovered on disk; no internal file manifest enters the project JSON.
use crate::{
    model::{self, Project},
    project_io::{self, ProjectStore, Session},
};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn check(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(err(e)),
    }
}
// Hold each directory without FILE_SHARE_DELETE: checked directories cannot be
// replaced by a junction while a read/import/create/save protection is in flight.
fn guard(path: &Path) -> Result<File, String> {
    project_io::plain_path(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .custom_flags(0x02000000 | 0x00200000)
            .share_mode(1 | 2);
    }
    let file = options.open(path).map_err(err)?;
    let meta = file.metadata().map_err(err)?;
    check(meta.is_dir(), "内部目录路径不是文件夹")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        check(meta.file_attributes() & 0x400 == 0, "拒绝重解析点目录")?;
    }
    Ok(file)
}
fn components(relative: &str) -> Result<Vec<&str>, String> {
    if relative.is_empty() {
        return Ok(vec![]);
    }
    let parts: Vec<_> = relative.split('/').collect();
    check(
        relative.len() <= 4096
            && parts.len() <= 32
            && parts.iter().all(|p| model::valid_filename(p)),
        "内部相对路径无效，禁止绝对路径、空组件和目录穿越",
    )?;
    Ok(parts)
}
struct Directory {
    path: PathBuf,
    _guards: Vec<File>,
}
fn directory(
    root: &Path,
    node: &str,
    relative: &str,
    create: bool,
) -> Result<Option<Directory>, String> {
    check(model::valid_node_id(node), "节点 ID 不是安全目录名")?;
    let parts = components(relative)?;
    let mut guards = vec![guard(root)?];
    let mut path = root.to_path_buf();
    for (index, part) in ["Nodes", node].into_iter().chain(parts).enumerate() {
        path.push(part);
        if !exists(&path)? {
            if create && index < 2 {
                fs::create_dir(&path).map_err(err)?;
            } else if index < 2 {
                return Ok(None);
            } else {
                return Err("内部子目录不存在；未自动创建".into());
            }
        }
        guards.push(guard(&path)?);
        check(
            fs::canonicalize(&path).map_err(err)? == path,
            "内部目录逃逸或已移动",
        )?;
    }
    Ok(Some(Directory {
        path,
        _guards: guards,
    }))
}
fn session_project(session: &Session) -> Result<Project, String> {
    project_io::check_path(session)?;
    check(
        project_io::read_json_path_matches(session)?,
        "项目 JSON 已被外部更改；请保留当前草稿并重新检查",
    )?;
    model::parse(std::str::from_utf8(&session.last).map_err(err)?)
}
fn with_node<T>(
    store: &ProjectStore,
    token: &str,
    node: &str,
    action: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let sessions = store.0.lock().map_err(err)?;
    let session = sessions.get(token).ok_or("未授权的项目会话")?;
    let p = session_project(session)?;
    check(
        p.nodes.iter().any(|n| n.id == node),
        "节点不存在，请先保存节点",
    )?;
    action(&session.root)
}
fn with_node_read<T>(
    store: &ProjectStore,
    token: &str,
    node: &str,
    action: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let session = project_io::read_session(store, token)?;
    let p = session_project(&session)?;
    check(
        p.nodes.iter().any(|n| n.id == node),
        "节点不存在，请先保存节点",
    )?;
    action(&session.root)
}
pub fn list(
    store: &ProjectStore,
    token: &str,
    node: &str,
    relative: &str,
) -> Result<Vec<Entry>, String> {
    with_node_read(store, token, node, |root| {
        let Some(dir) = directory(root, node, relative, false)? else {
            return Ok(vec![]);
        };
        let mut entries = Vec::new();
        for entry in fs::read_dir(&dir.path).map_err(err)? {
            let entry = entry.map_err(err)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "文件名不是有效 Unicode")?;
            check(model::valid_filename(&name), "目录中存在不安全文件名")?;
            let meta = fs::symlink_metadata(entry.path()).map_err(err)?;
            check(!meta.file_type().is_symlink(), "拒绝符号链接目录项")?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                check(meta.file_attributes() & 0x400 == 0, "拒绝重解析点目录项")?;
            }
            check(meta.is_file() || meta.is_dir(), "目录包含不支持的文件类型")?;
            entries.push(Entry {
                path: if relative.is_empty() {
                    name.clone()
                } else {
                    format!("{relative}/{name}")
                },
                name,
                is_directory: meta.is_dir(),
                size: meta.len(),
            });
            check(
                entries.len() <= 10_000,
                "单层目录超过10000项，请在资源管理器中整理",
            )?;
        }
        entries.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    })
}
fn filename(name: &str) -> Result<(), String> {
    check(
        model::valid_filename(name),
        "文件名无效：禁止路径、保留名、末尾点或空格",
    )
}
fn no_conflict(dir: &Path, name: &str) -> Result<(), String> {
    filename(name)?;
    for entry in fs::read_dir(dir).map_err(err)? {
        let entry = entry.map_err(err)?;
        check(
            entry.file_name().to_string_lossy().to_lowercase() != name.to_lowercase(),
            "同名文件或目录已存在（忽略大小写），不会覆盖",
        )?;
    }
    Ok(())
}
fn publish(
    dir: &Path,
    name: &str,
    write: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    no_conflict(dir, name)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".forest-import-")
        .tempfile_in(dir)
        .map_err(err)?;
    write(temp.as_file_mut())?;
    temp.as_file().sync_all().map_err(err)?;
    no_conflict(dir, name)?;
    temp.persist_noclobber(dir.join(name)).map_err(err)?;
    Ok(())
}
pub fn create(
    store: &ProjectStore,
    token: &str,
    node: &str,
    relative: &str,
    name: &str,
) -> Result<(), String> {
    filename(name)?;
    check(
        name.ends_with(".md") || name.ends_with(".txt"),
        "只能新建 .md 或 .txt 文件",
    )?;
    with_node(store, token, node, |root| {
        let dir = directory(root, node, relative, true)?.ok_or("内部目录不存在")?;
        publish(&dir.path, name, |_| Ok(()))
    })
}
fn open_source(path: &Path) -> Result<File, String> {
    project_io::plain_path(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(1);
    }
    let file = options.open(path).map_err(err)?;
    let meta = file.metadata().map_err(err)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        check(meta.file_attributes() & 0x400 == 0, "拒绝重解析点文件")?;
    }
    check(meta.is_file(), "只能操作普通文件")?;
    Ok(file)
}
pub fn import(
    store: &ProjectStore,
    token: &str,
    node: &str,
    relative: &str,
    source: &Path,
) -> Result<(), String> {
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("来源文件名无效")?;
    filename(name)?;
    // The absolute source is supplied only by the native picker, never by IPC.
    let mut input = open_source(source)?;
    with_node(store, token, node, |root| {
        let dir = directory(root, node, relative, true)?.ok_or("内部目录不存在")?;
        publish(&dir.path, name, |output| {
            std::io::copy(&mut input, output).map_err(err)?;
            Ok(())
        })
    })
}
pub(crate) fn with_target<T>(
    store: &ProjectStore,
    token: &str,
    node: &str,
    relative: &str,
    action: impl FnOnce(&Path, bool) -> Result<T, String>,
) -> Result<T, String> {
    let mut parts = components(relative)?;
    let name = parts.pop().ok_or("请选择内部文件或文件夹")?;
    with_node(store, token, node, |root| {
        let parent = parts.join("/");
        let dir = directory(root, node, &parent, false)?.ok_or("内部目录不存在")?;
        let path = dir.path.join(name);
        project_io::plain_path(&path)?;
        let meta = fs::symlink_metadata(&path).map_err(err)?;
        if meta.is_dir() {
            let _target = directory(root, node, relative, false)?.ok_or("内部目录不存在")?;
            action(&path, true)
        } else {
            let _file = open_source(&path)?;
            check(
                fs::canonicalize(&path).map_err(err)? == path,
                "内部文件超出节点边界",
            )?;
            action(&path, false)
        }
    })
}
pub fn read(
    store: &ProjectStore,
    token: &str,
    node: &str,
    relative: &str,
) -> Result<String, String> {
    let mut parts = components(relative)?;
    let name = parts.pop().ok_or("请选择内部文件")?;
    let parent = parts.join("/");
    with_node(store, token, node, |root| {
        let dir = directory(root, node, &parent, false)?.ok_or("内部目录不存在")?;
        let file = open_source(&dir.path.join(name))?;
        check(
            file.metadata().map_err(err)?.len() <= 2 * 1024 * 1024,
            "文本读取上限为2MiB；文件保留不变",
        )?;
        let mut bytes = Vec::new();
        file.take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        check(bytes.len() <= 2 * 1024 * 1024, "文本超过读取上限")?;
        String::from_utf8(bytes).map_err(|_| "此文件不是 UTF-8 文本；已保存的文件未改动".into())
    })
}
fn contains_files(root: &Path, node: &str) -> Result<bool, String> {
    let Some(dir) = directory(root, node, "", false)? else {
        return Ok(false);
    };
    let mut stack = vec![dir];
    let mut inspected = 0;
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir.path).map_err(err)? {
            let entry = entry.map_err(err)?;
            project_io::plain_path(&entry.path())?;
            let meta = entry.metadata().map_err(err)?;
            if meta.is_file() {
                return Ok(true);
            }
            check(
                meta.is_dir(),
                "内部目录中存在不支持的文件类型，停止删除/复制",
            )?;
            inspected += 1;
            check(
                inspected <= 10_000,
                "内部目录过多，无法安全检查，停止删除/复制",
            )?;
            let handle = guard(&entry.path())?;
            // Keep ancestor handles for the entire traversal.
            let mut held = Vec::new();
            for file in &dir._guards {
                held.push(file.try_clone().map_err(err)?)
            }
            held.push(handle);
            stack.push(Directory {
                path: entry.path(),
                _guards: held,
            });
        }
    }
    Ok(false)
}
pub fn protect(
    root: &Path,
    project: &Project,
    ids: &[String],
    descendants: bool,
) -> Result<(), String> {
    let mut chosen: HashSet<_> = ids.iter().cloned().collect();
    check(
        ids.iter()
            .all(|id| project.nodes.iter().any(|n| &n.id == id)),
        "检查节点不存在",
    )?;
    if descendants {
        loop {
            let mut changed = false;
            for node in &project.nodes {
                if node
                    .parent_id
                    .as_ref()
                    .is_some_and(|id| chosen.contains(id))
                {
                    changed |= chosen.insert(node.id.clone());
                }
            }
            if !changed {
                break;
            }
        }
    }
    for node in &project.nodes {
        if chosen.contains(&node.id) && contains_files(root, &node.id)? {
            return Err(format!(
                "节点“{}”或后代含内部文件，MVP-1 暂不支持此删除/复制；文件与节点保留",
                node.title
            ));
        }
    }
    Ok(())
}
pub fn check_nodes(
    store: &ProjectStore,
    token: &str,
    ids: &[String],
    descendants: bool,
) -> Result<(), String> {
    let sessions = store.0.lock().map_err(err)?;
    let session = sessions.get(token).ok_or("未授权的项目会话")?;
    let p = session_project(session)?;
    protect(&session.root, &p, ids, descendants)
}
pub fn protect_changes(
    root: &Path,
    before: &Project,
    after: &Project,
    known: &HashSet<String>,
) -> Result<(), String> {
    // JSON-only deletion intentionally retains Nodes/<ID>. Only IDs previously
    // observed in this session or copied by the backend may reclaim existing files.
    let previous: HashSet<_> = before.nodes.iter().map(|n| n.id.as_str()).collect();
    for node in &after.nodes {
        if !previous.contains(node.id.as_str()) && !known.contains(&node.id) {
            check(
                !contains_files(root, &node.id)?,
                "新节点 ID 对应已有内部文件，拒绝复用目录",
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        _temp: tempfile::TempDir,
        store: ProjectStore,
        token: String,
        root: PathBuf,
        path: PathBuf,
        json: String,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let store = ProjectStore::default();
            let opened = project_io::create(&store, temp.path(), model::sample()).unwrap();
            let root = Path::new(&opened.path).parent().unwrap().to_path_buf();
            let mut p: serde_json::Value = serde_json::from_str(&opened.json).unwrap();
            p["nodes"] = serde_json::json!([
                {"id":"root","title":"父","parentId":null,"weight":1,"progress":73,"color":null},
                {"id":"child","title":"子","parentId":"root","weight":0,"progress":42,"color":null},
                {"id":"other","title":"其他根","parentId":null,"weight":1,"progress":0,"color":null}
            ]);
        p["views"]["tree"]["positions"] = serde_json::json!({"root":{"x":0,"y":0},"child":{"x":300,"y":0},"other":{"x":0,"y":300}});
            let json = p.to_string();
            project_io::save(&store, &opened.token, &json).unwrap();
            Self {
                _temp: temp,
                store,
                token: opened.token,
                root,
                path: opened.path.into(),
                json,
            }
        }
        fn create(&self, name: &str) -> Result<(), String> {
            create(&self.store, &self.token, "child", "", name)
        }
        fn json_unchanged(&self) {
            assert_eq!(fs::read_to_string(&self.path).unwrap(), self.json)
        }
    }
    #[test]
    fn empty_project_node_and_listing_never_create_directories() {
        let f = Fixture::new();
        assert!(!f.root.join("Nodes").exists());
        assert!(list(&f.store, &f.token, "child", "").unwrap().is_empty());
        assert!(!f.root.join("Nodes").exists());
        f.json_unchanged();
    }
    #[test]
    fn first_md_txt_are_lazy_and_discovered_after_reopen_without_manifest() {
        let f = Fixture::new();
        f.create("README.md").unwrap();
        f.create("notes.txt").unwrap();
        assert!(!f.root.join("Nodes/root").exists());
        assert!(!f.root.join("Markdown").exists());
        let entries = list(&f.store, &f.token, "child", "").unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| !e.is_directory && e.size == 0));
        f.json_unchanged();
        let next = ProjectStore::default();
        let opened = project_io::open(&next, &f.path).unwrap();
        assert_eq!(list(&next, &opened.token, "child", "").unwrap().len(), 2);
        assert_eq!(
            read(&next, &opened.token, "child", "README.md").unwrap(),
            ""
        );
        assert!(!opened.json.contains("documents"));
        assert!(!opened.json.contains("folderPath"));
    }
    #[test]
    fn conflicts_files_and_directories_never_overwrite() {
        let f = Fixture::new();
        f.create("notes.txt").unwrap();
        fs::write(f.root.join("Nodes/child/notes.txt"), "original").unwrap();
        assert!(f.create("notes.txt").is_err());
        assert!(f.create("NOTES.txt").is_err());
        fs::create_dir(f.root.join("Nodes/child/folder.md")).unwrap();
        assert!(f.create("folder.md").is_err());
        assert_eq!(
            read(&f.store, &f.token, "child", "notes.txt").unwrap(),
            "original"
        );
        f.json_unchanged();
    }
    #[test]
    fn import_is_independent_binary_copy_and_never_modifies_source() {
        let f = Fixture::new();
        let source = f._temp.path().join("外部.bin");
        let bytes = [0, 255, 13, 10, 7];
        fs::write(&source, bytes).unwrap();
        import(&f.store, &f.token, "child", "", &source).unwrap();
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(
            fs::read(f.root.join("Nodes/child/外部.bin")).unwrap(),
            bytes
        );
        assert!(import(&f.store, &f.token, "child", "", &source).is_err());
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert!(read(&f.store, &f.token, "child", "外部.bin").is_err());
        f.json_unchanged();
    }
    #[test]
    fn nested_directories_are_enumerated_and_utf8_read_literally() {
        let f = Fixture::new();
        f.create("root.md").unwrap();
        fs::create_dir(f.root.join("Nodes/child/sub")).unwrap();
        fs::write(
            f.root.join("Nodes/child/sub/内容.txt"),
            "中文<script>alert(1)</script>",
        )
        .unwrap();
        let entries = list(&f.store, &f.token, "child", "").unwrap();
        assert!(entries[0].is_directory);
        assert_eq!(entries[0].path, "sub");
        let sub = list(&f.store, &f.token, "child", "sub").unwrap();
        assert_eq!(sub[0].path, "sub/内容.txt");
        assert!(read(&f.store, &f.token, "child", &sub[0].path)
            .unwrap()
            .contains("<script>"));
        create(&f.store, &f.token, "child", "sub", "new.md").unwrap();
        assert!(list(&f.store, &f.token, "child", "missing").is_err());
        assert!(!f.root.join("Nodes/child/missing").exists());
    }
    #[test]
    fn rejects_ids_names_traversal_absolute_ads_and_bad_tokens() {
        let f = Fixture::new();
        for id in ["../child", "child/..", "C:", "CON", "child\\x", "missing"] {
            assert!(create(&f.store, &f.token, id, "", "a.md").is_err());
        }
        for name in [
            "../x.md",
            "a/b.txt",
            "a\\b.md",
            "CON.md",
            "a:ads.txt",
            "x.txt ",
            "..",
            "x.exe",
        ] {
            assert!(f.create(name).is_err(), "{name}");
        }
        for relative in [
            "../other", "/tmp", "C:/temp", "sub/../x", "sub\\x", ".", "a//b",
        ] {
            assert!(
                list(&f.store, &f.token, "child", relative).is_err(),
                "{relative}"
            );
        }
        assert!(list(&f.store, "bad", "child", "").is_err());
        assert!(!f.root.join("Nodes").exists());
        f.json_unchanged();
    }
    #[test]
    fn file_parent_path_and_missing_project_are_not_adopted_or_recreated() {
        let f = Fixture::new();
        fs::write(f.root.join("Nodes"), "sentinel").unwrap();
        assert!(f.create("a.md").is_err());
        assert_eq!(
            fs::read_to_string(f.root.join("Nodes")).unwrap(),
            "sentinel"
        );
        f.json_unchanged();
        let f = Fixture::new();
        let moved = f._temp.path().join("moved");
        fs::rename(&f.root, &moved).unwrap();
        assert!(f.create("a.md").is_err());
        assert!(!f.root.exists());
    }
    #[test]
    fn incomplete_copy_never_publishes_partial_target_or_touches_existing_file() {
        let f = Fixture::new();
        f.create("existing.md").unwrap();
        let dir = f.root.join("Nodes/child");
        let failure = publish(&dir, "broken.txt", |file| {
            use std::io::Write;
            file.write_all(b"half").unwrap();
            Err("injected copy failure".into())
        });
        assert!(failure.is_err());
        assert!(!dir.join("broken.txt").exists());
        assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
        f.json_unchanged();
    }
    #[test]
    fn node_and_ancestor_json_delete_undo_retain_internal_files() {
        let f = Fixture::new();
        f.create("content.txt").unwrap();
        for id in ["child", "root"] {
            assert!(check_nodes(&f.store, &f.token, &[id.into()], true).is_err());
        }
        assert!(check_nodes(&f.store, &f.token, &["root".into()], false).is_ok());
        for remove in [vec!["child"], vec!["root"], vec!["root", "child"]] {
            let mut p: serde_json::Value = serde_json::from_str(&f.json).unwrap();
            let remaining: Vec<_> = p["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|n| !remove.contains(&n["id"].as_str().unwrap()))
                .map(|n| {
                    let mut n = n.clone();
                    n["parentId"] = serde_json::Value::Null;
                    n
                })
                .collect();
            p["nodes"] = remaining.into();
            p["views"]["tree"]["positions"].as_object_mut().unwrap().retain(|id, _| !remove.contains(&id.as_str()));
            project_io::save(&f.store, &f.token, &p.to_string()).unwrap();
            assert_eq!(
                fs::read_to_string(f.root.join("Nodes/child/content.txt")).unwrap(),
                ""
            );
            project_io::save(&f.store, &f.token, &f.json).unwrap();
            f.json_unchanged();
        }
        fs::create_dir(f.root.join("Nodes/child/nested")).unwrap();
        fs::rename(
            f.root.join("Nodes/child/content.txt"),
            f.root.join("Nodes/child/nested/content.txt"),
        )
        .unwrap();
        assert!(check_nodes(&f.store, &f.token, &["root".into()], true).is_err());
    }
    #[test]
    fn rename_move_reparent_weight_save_preserve_directory_and_progress() {
        let f = Fixture::new();
        f.create("content.txt").unwrap();
        let mut p: serde_json::Value = serde_json::from_str(&f.json).unwrap();
        p["nodes"][1]["title"] = "新标题".into();
        p["views"]["tree"]["positions"]["child"]["x"] = 500.into();
        p["nodes"][1]["parentId"] = "other".into();
        p["nodes"][1]["weight"] = 1.into();
        project_io::save(&f.store, &f.token, &p.to_string()).unwrap();
        assert_eq!(
            model::parse(&fs::read_to_string(&f.path).unwrap())
                .unwrap()
                .nodes[1]
                .progress,
            42.0
        );
        assert!(f.root.join("Nodes/child/content.txt").exists());
        assert!(!f.root.join("Nodes/新标题").exists());
        // External files in an otherwise unused ID must not be silently adopted by a new node.
        fs::create_dir(f.root.join("Nodes/new-id")).unwrap();
        fs::write(f.root.join("Nodes/new-id/private.txt"), "private").unwrap();
        let mut new = p["nodes"][2].clone();
        new["id"] = "new-id".into();
        p["nodes"].as_array_mut().unwrap().push(new);
        p["views"]["tree"]["positions"]["new-id"] = serde_json::json!({"x":0,"y":0});
        assert!(project_io::save(&f.store, &f.token, &p.to_string()).is_err());
    }
    #[test]
    fn external_json_change_prevents_file_write_and_read_size_limit_preserves_file() {
        let f = Fixture::new();
        f.create("big.txt").unwrap();
        let path = f.root.join("Nodes/child/big.txt");
        fs::write(&path, vec![65; 2 * 1024 * 1024 + 1]).unwrap();
        assert!(read(&f.store, &f.token, "child", "big.txt").is_err());
        assert_eq!(fs::metadata(path).unwrap().len(), 2 * 1024 * 1024 + 1);
        fs::write(&f.path, "external").unwrap();
        assert!(f.create("blocked.md").is_err());
        assert!(!f.root.join("Nodes/child/blocked.md").exists());
    }
    #[cfg(windows)]
    #[test]
    fn windows_junctions_at_nodes_node_or_subdirectory_never_escape() {
        for relative in ["Nodes", "Nodes/child", "Nodes/child/sub"] {
            let f = Fixture::new();
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("sentinel.txt"), "private").unwrap();
            let link = f.root.join(relative);
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            let result=std::process::Command::new("powershell.exe").args(["-NoProfile","-Command","New-Item -ItemType Junction -Path $env:FOREST_TEST_LINK -Target $env:FOREST_TEST_OUTSIDE | Out-Null"]).env("FOREST_TEST_LINK",&link).env("FOREST_TEST_OUTSIDE",outside.path()).output().unwrap();
            assert!(result.status.success());
            let sub = if relative.ends_with("/sub") {
                "sub"
            } else {
                ""
            };
            assert!(list(&f.store, &f.token, "child", sub).is_err());
            assert!(create(&f.store, &f.token, "child", sub, "escape.md").is_err());
            assert!(check_nodes(&f.store, &f.token, &["root".into()], true).is_err());
            assert!(
                copy_nodes(&f.store, &f.token, &[("child".into(), "safe-copy".into())]).is_err()
            );
            assert!(!f.root.join("Nodes/safe-copy").exists());
            assert!(!outside.path().join("escape.md").exists());
            assert_eq!(
                fs::read_to_string(outside.path().join("sentinel.txt")).unwrap(),
                "private"
            );
            fs::remove_dir(link).unwrap();
            f.json_unchanged();
        }
    }
    #[cfg(windows)]
    #[test]
    fn windows_locked_source_import_is_rejected_without_partial_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new();
        let source = f._temp.path().join("locked.txt");
        fs::write(&source, "original").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&source)
            .unwrap();
        assert!(import(&f.store, &f.token, "child", "", &source).is_err());
        drop(lock);
        assert_eq!(fs::read_to_string(source).unwrap(), "original");
        assert!(!f.root.join("Nodes").exists());
        f.json_unchanged();
    }
    #[test]
    fn copying_empty_nodes_does_not_create_nodes_directory() {
        let f = Fixture::new();
        copy_nodes(&f.store, &f.token, &[("root".into(), "copy-empty".into())]).unwrap();
        assert!(!f.root.join("Nodes").exists());
        f.json_unchanged();
    }
    #[test]
    fn copied_trees_are_independent_and_survive_undo_redo_reopen() {
        let f = Fixture::new();
        f.create("笔记.txt").unwrap();
        fs::write(f.root.join("Nodes/child/笔记.txt"), [0, 255, 3]).unwrap();
        fs::create_dir_all(f.root.join("Nodes/child/中文 空格/empty")).unwrap();
        fs::write(f.root.join("Nodes/child/中文 空格/file.md"), "original").unwrap();
        copy_nodes(&f.store, &f.token, &[("child".into(), "clone".into())]).unwrap();
        assert_eq!(
            fs::read(f.root.join("Nodes/clone/笔记.txt")).unwrap(),
            [0, 255, 3]
        );
        assert!(f.root.join("Nodes/clone/中文 空格/empty").is_dir());
        fs::write(f.root.join("Nodes/clone/中文 空格/file.md"), "changed").unwrap();
        assert_eq!(
            fs::read_to_string(f.root.join("Nodes/child/中文 空格/file.md")).unwrap(),
            "original"
        );
        let mut p = model::parse(&f.json).unwrap();
        let mut clone = p.nodes[1].clone();
        clone.id = "clone".into();
        p.nodes.push(clone);
        p.views.tree.positions.insert("clone".into(), model::Point { x: 500., y: 0. });
        let copied = serde_json::to_string(&p).unwrap();
        project_io::save(&f.store, &f.token, &copied).unwrap();
        project_io::save(&f.store, &f.token, &f.json).unwrap();
        assert!(f.root.join("Nodes/clone/笔记.txt").exists());
        project_io::save(&f.store, &f.token, &copied).unwrap();
        let next = project_io::open(&f.store, &f.path).unwrap();
        assert_eq!(
            read(&f.store, &next.token, "clone", "中文 空格/file.md").unwrap(),
            "changed"
        );
        assert!(copy_nodes(&f.store, &f.token, &[("child".into(), "clone".into())]).is_err());
    }
    #[test]
    fn file_copy_rejects_ids_unknown_sources_duplicate_and_existing_destinations() {
        let f = Fixture::new();
        f.create("keep.txt").unwrap();
        for pairs in [
            vec![("child", "../bad")],
            vec![("../bad", "copy")],
            vec![("unknown", "copy")],
            vec![("child", "child")],
            vec![("child", "ROOT")],
            vec![("child", "copy"), ("root", "COPY")],
        ] {
            let pairs: Vec<_> = pairs
                .into_iter()
                .map(|(a, b)| (a.into(), b.into()))
                .collect();
            assert!(copy_nodes(&f.store, &f.token, &pairs).is_err());
        }
        fs::create_dir(f.root.join("Nodes/occupied")).unwrap();
        fs::write(f.root.join("Nodes/occupied/private.txt"), "private").unwrap();
        assert!(copy_nodes(&f.store, &f.token, &[("child".into(), "occupied".into())]).is_err());
        assert!(copy_nodes(&f.store, "bad", &[]).is_err());
        assert_eq!(
            fs::read_to_string(f.root.join("Nodes/occupied/private.txt")).unwrap(),
            "private"
        );
        f.json_unchanged();
    }
    #[test]
    fn deleted_source_files_can_be_pasted_without_losing_retained_content() {
        let f = Fixture::new();
        f.create("保留.md").unwrap();
        let mut p = model::parse(&f.json).unwrap();
        let mut clone = p.nodes.remove(1);
        p.views.tree.positions.remove("child");
        clone.id = "from-deleted".into();
        project_io::save(&f.store, &f.token, &serde_json::to_string(&p).unwrap()).unwrap();
        copy_nodes(&f.store, &f.token, &[("child".into(), clone.id.clone())]).unwrap();
        p.nodes.push(clone);
        p.views.tree.positions.insert("from-deleted".into(), model::Point { x: 500., y: 0. });
        project_io::save(&f.store, &f.token, &serde_json::to_string(&p).unwrap()).unwrap();
        assert!(f.root.join("Nodes/child/保留.md").exists());
        assert!(f.root.join("Nodes/from-deleted/保留.md").exists());
    }
    #[test]
    fn retained_directories_remain_project_data_when_renaming_after_reopen() {
        let f = Fixture::new();
        f.create("保留.md").unwrap();
        let mut p = model::parse(&f.json).unwrap();
        p.nodes.remove(1);
        p.views.tree.positions.remove("child");
        project_io::save(&f.store, &f.token, &serde_json::to_string(&p).unwrap()).unwrap();
        f.store.0.lock().unwrap().remove(&f.token);
        let opened = project_io::open(&f.store, &f.path).unwrap();
        let renamed = project_io::rename(&f.store, &opened.token, "改名后").unwrap();
        assert!(Path::new(&renamed.path)
            .parent()
            .unwrap()
            .join("Nodes/child/保留.md")
            .exists());
    }
    #[cfg(windows)]
    #[test]
    fn failed_batch_copy_publishes_no_partial_nodes() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new();
        f.create("good.txt").unwrap();
        create(&f.store, &f.token, "other", "", "locked.txt").unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(f.root.join("Nodes/other/locked.txt"))
            .unwrap();
        assert!(copy_nodes(
            &f.store,
            &f.token,
            &[
                ("child".into(), "first".into()),
                ("other".into(), "second".into())
            ]
        )
        .is_err());
        drop(locked);
        assert!(!f.root.join("Nodes/first").exists());
        assert!(!f.root.join("Nodes/second").exists());
        assert_eq!(fs::read_dir(f.root.join("Nodes")).unwrap().count(), 2);
        f.json_unchanged();
    }
}

/// Publish an entire copied folder only after every entry has been validated and copied.
pub fn import_folder(
    store: &ProjectStore,
    token: &str,
    node: &str,
    relative: &str,
    source: &Path,
) -> Result<(), String> {
    project_io::plain_path(source)?;
    let source = fs::canonicalize(source).map_err(err)?;
    project_io::plain_path(&source)?;
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("文件夹名称无效")?;
    with_node(store, token, node, |root| {
        let dir = directory(root, node, relative, true)?.ok_or("节点目录不存在")?;
        check(
            !dir.path.starts_with(&source),
            "不能把文件夹复制进自身或其后代",
        )?;
        no_conflict(&dir.path, name)?;
        let temp = tempfile::Builder::new()
            .prefix(".forest-folder-")
            .tempdir_in(&dir.path)
            .map_err(err)?;
        let mut count = 0;
        let mut bytes = 0;
        copy_folder(&source, temp.path(), 0, &mut count, &mut bytes)?;
        no_conflict(&dir.path, name)?;
        // On Windows directory rename refuses an existing destination. Never merge or overwrite.
        fs::rename(temp.path(), dir.path.join(name)).map_err(err)?;
        Ok(())
    })
}
fn copy_folder(
    source: &Path,
    target: &Path,
    depth: usize,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    check(depth <= 30, "导入文件夹层级超过30层")?;
    let _source = guard(source)?;
    for item in fs::read_dir(source).map_err(err)? {
        let item = item.map_err(err)?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| "文件名称不是 Unicode")?;
        filename(&name)?;
        project_io::plain_path(&item.path())?;
        *count += 1;
        check(*count <= 10_000, "单次导入超过10000项")?;
        let meta = fs::symlink_metadata(item.path()).map_err(err)?;
        let destination = target.join(name);
        if meta.is_dir() {
            fs::create_dir(&destination).map_err(err)?;
            copy_folder(&item.path(), &destination, depth + 1, count, bytes)?;
        } else {
            let mut source_file = open_source(&item.path())?;
            *bytes = bytes.checked_add(meta.len()).ok_or("导入大小溢出")?;
            check(*bytes <= 2 * 1024 * 1024 * 1024, "单次导入上限2GiB")?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(err)?;
            std::io::copy(&mut source_file, &mut output).map_err(err)?;
            output.sync_all().map_err(err)?;
        }
    }
    Ok(())
}
pub fn rename_file(
    store: &ProjectStore,
    token: &str,
    node: &str,
    relative: &str,
    name: &str,
) -> Result<(), String> {
    filename(name)?;
    let mut parts = components(relative)?;
    let old = parts.pop().ok_or("请选择内部文件")?;
    with_node(store, token, node, |root| {
        let dir = directory(root, node, &parts.join("/"), false)?.ok_or("内部目录不存在")?;
        let path = dir.path.join(old);
        let file = open_source(&path)?;
        if old == name {
            return Ok(());
        }
        no_conflict(&dir.path, name)?;
        // create_new semantics: a same-directory hard link cannot replace another file.
        let destination = dir.path.join(name);
        fs::hard_link(&path, &destination).map_err(err)?;
        drop(file);
        fs::remove_file(&path)
            .map_err(|e| format!("新名称已保留，旧名称未移除；请刷新检查：{e}"))?;
        Ok(())
    })
}
pub fn delete_file(
    store: &ProjectStore,
    token: &str,
    node: &str,
    relative: &str,
) -> Result<(), String> {
    delete_file_with(store, token, node, relative, crate::system_files::recycle)
}
fn delete_file_with(
    store: &ProjectStore,
    token: &str,
    node: &str,
    relative: &str,
    recycle: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let mut parts = components(relative)?;
    let name = parts.pop().ok_or("请选择内部文件")?;
    with_node(store, token, node, |root| {
        let dir = directory(root, node, &parts.join("/"), false)?.ok_or("内部目录不存在")?;
        let path = dir.path.join(name);
        let file = open_source(&path)?;
        drop(file);
        // Directory guards stay live. Windows presents its own recycle/permanent-delete confirmation.
        recycle(&path)
    })
}

#[cfg(test)]
mod card_file_tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, ProjectStore, String, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = project_io::create(&store, temp.path(), model::sample()).unwrap();
        let root = Path::new(&opened.path).parent().unwrap().to_path_buf();
        let mut p: serde_json::Value = serde_json::from_str(&opened.json).unwrap();
        p["nodes"] = serde_json::json!([{"id":"a","title":"A","parentId":null,"progress":73,"weight":0,"color":null}]);
        p["views"]["tree"]["positions"] = serde_json::json!({"a":{"x":3,"y":4}});
        let json = p.to_string();
        project_io::save(&store, &opened.token, &json).unwrap();
        (temp, store, opened.token, root, json)
    }

    #[test]
    fn read_listing_does_not_hold_project_save_mutex() {
        let (_t, s, token, _root, _json) = fixture();
        with_node_read(&s, &token, "a", |_root| {
            let lock =
                s.0.try_lock()
                    .expect("directory read must release save mutex");
            drop(lock);
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn large_internal_and_external_directory_roundtrip() {
        let (_t, store, token, root, json) = fixture();
        create(&store, &token, "a", "", "seed.txt").unwrap();
        let folder = root.join("Nodes/a");
        for i in 0..2000 {
            fs::write(folder.join(format!("file-{i:04}.txt")), b"x").unwrap();
        }
        let start = std::time::Instant::now();
        let rows = list(&store, &token, "a", "").unwrap();
        let internal_ms = start.elapsed().as_millis();
        assert_eq!(rows.len(), 2001);
        let mut p: serde_json::Value = serde_json::from_str(&json).unwrap();
        p["nodes"][0]["linkedPaths"] = serde_json::json!(["Nodes/a"]);
        project_io::save(&store, &token, &p.to_string()).unwrap();
        let start = std::time::Instant::now();
        let external = crate::external_files::list(&store, &token, "a", "Nodes/a", "").unwrap();
        let external_ms = start.elapsed().as_millis();
        assert_eq!(external.len(), 2001);
        assert_eq!(fs::read(folder.join("file-1999.txt")).unwrap(), b"x");
        println!("REAL_DIRECTORY_2001 internal_ms={internal_ms} external_ms={external_ms}");
    }
    #[test]
    fn folder_copy_is_deep_discovered_and_never_modifies_source_or_json() {
        let (t, s, token, root, json) = fixture();
        let source = t.path().join("中文 空格");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested/原件.bin"), [0, 255, 7]).unwrap();
        import_folder(&s, &token, "a", "", &source).unwrap();
        assert_eq!(
            fs::read(root.join("Nodes/a/中文 空格/nested/原件.bin")).unwrap(),
            [0, 255, 7]
        );
        assert_eq!(
            fs::read(source.join("nested/原件.bin")).unwrap(),
            [0, 255, 7]
        );
        assert_eq!(
            list(&s, &token, "a", "中文 空格").unwrap()[0].name,
            "nested"
        );
        assert!(import_folder(&s, &token, "a", "", &source).is_err());
        assert_eq!(
            fs::read_to_string(root.join("测试项目.json")).unwrap(),
            json
        );
    }
    #[test]
    fn folder_self_import_traversal_and_failed_copy_never_publish_partial() {
        let (t, s, token, root, _) = fixture();
        create(&s, &token, "a", "", "keep.txt").unwrap();
        assert!(import_folder(&s, &token, "a", "", &root).is_err());
        assert!(import_folder(&s, &token, "a", "../", t.path()).is_err());
        let source = t.path().join("bad-folder");
        fs::create_dir(&source).unwrap();
        let mut deep = source.clone();
        for _ in 0..32 {
            deep = deep.join("d");
            fs::create_dir(&deep).unwrap();
        }
        assert!(import_folder(&s, &token, "a", "", &source).is_err());
        assert!(!root.join("Nodes/a/bad-folder").exists());
        assert_eq!(fs::read(root.join("Nodes/a/keep.txt")).unwrap(), b"");
    }
    #[test]
    fn rename_conflicts_and_recycle_error_preserve_content() {
        let (t, s, token, root, json) = fixture();
        create(&s, &token, "a", "", "before.txt").unwrap();
        fs::write(root.join("Nodes/a/before.txt"), "original").unwrap();
        create(&s, &token, "a", "", "exists.txt").unwrap();
        assert!(rename_file(&s, &token, "a", "before.txt", "EXISTS.txt").is_err());
        assert!(rename_file(&s, &token, "a", "before.txt", "../bad.txt").is_err());
        rename_file(&s, &token, "a", "before.txt", "改名.txt").unwrap();
        assert!(!root.join("Nodes/a/before.txt").exists());
        let path = root.join("Nodes/a/改名.txt");
        assert!(
            delete_file_with(&s, &token, "a", "改名.txt", |_| Err("cancelled".into())).is_err()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        let held = t.path().join("recycled.txt");
        delete_file_with(&s, &token, "a", "改名.txt", |p| {
            fs::rename(p, &held).map_err(err)
        })
        .unwrap();
        assert_eq!(fs::read_to_string(held).unwrap(), "original");
        assert!(
            delete_file_with(&s, &token, "a", "../bad", |_| panic!("must not recycle")).is_err()
        );
        assert_eq!(
            fs::read_to_string(root.join("测试项目.json")).unwrap(),
            json
        );
    }
    #[cfg(windows)]
    #[test]
    fn folder_import_rejects_junction_and_keeps_source() {
        let (t, s, token, root, _) = fixture();
        let source = t.path().join("junction-source");
        fs::create_dir(&source).unwrap();
        let link = source.join("link");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&root)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(import_folder(&s, &token, "a", "", &source).is_err());
        assert!(!root.join("Nodes/a/junction-source").exists());
        fs::remove_dir(link).unwrap();
    }
}

/// Copy internal trees to fresh IDs before the canvas publishes the new nodes.
/// All sources are from this project; linkedPaths are never followed here.
pub fn copy_nodes(
    store: &ProjectStore,
    token: &str,
    pairs: &[(String, String)],
) -> Result<(), String> {
    let mut sessions = store.0.lock().map_err(err)?;
    let session = sessions.get_mut(token).ok_or("未授权的项目会话")?;
    session_project(session)?;
    check(pairs.len() <= 10_000, "单次复制节点过多")?;
    let mut targets = HashSet::new();
    let mut sources = Vec::new();
    for (source, target) in pairs {
        check(
            model::valid_node_id(source) && model::valid_node_id(target),
            "复制节点ID无效",
        )?;
        check(
            session.known_node_ids.contains(source),
            "复制来源不属于当前项目",
        )?;
        check(
            !session
                .known_node_ids
                .iter()
                .any(|id| id.eq_ignore_ascii_case(target))
                && targets.insert(target.to_lowercase()),
            "复制目标ID已存在或重复",
        )?;
        check(
            !exists(&session.root.join("Nodes").join(target))?,
            "目标内部目录已存在，不会覆盖",
        )?;
        if let Some(dir) = directory(&session.root, source, "", false)? {
            sources.push((dir, target));
        }
    }
    if !sources.is_empty() {
        let nodes = session.root.join("Nodes");
        let _nodes_guard = guard(&nodes)?;
        let staging = tempfile::Builder::new()
            .prefix(".knode-copy-")
            .tempdir_in(&nodes)
            .map_err(err)?;
        let mut count = 0;
        let mut bytes = 0;
        for (source, target) in &sources {
            no_conflict(&nodes, target)?;
            let destination = staging.path().join(target);
            fs::create_dir(&destination).map_err(err)?;
            copy_folder(&source.path, &destination, 0, &mut count, &mut bytes)?;
        }
        // A read/copy failure above exposes no destination directories. Publication
        // failures retain any already published copies rather than risk data loss.
        for (_, target) in &sources {
            no_conflict(&nodes, target)?;
            fs::rename(staging.path().join(target), nodes.join(target))
                .map_err(|e| format!("复制发布失败；原文件及已完成副本保留，未添加节点：{e}"))?;
        }
    }
    session
        .known_node_ids
        .extend(pairs.iter().map(|(_, target)| target.clone()));
    Ok(())
}
