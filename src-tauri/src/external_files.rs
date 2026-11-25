//! External targets are references only. This module never opens a target for writing.
use crate::{
    model,
    project_io::{self, ProjectStore},
};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub status: String,
    pub message: String,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn with_node<T>(
    store: &ProjectStore,
    token: &str,
    node: &str,
    action: impl FnOnce(&Path, &[String]) -> Result<T, String>,
) -> Result<T, String> {
    let sessions = store.0.lock().map_err(error)?;
    let session = sessions.get(token).ok_or("未授权的项目会话")?;
    project_io::check_path(session)?;
    if !project_io::read_json_path_matches(session)? {
        return Err("项目 JSON 已被外部更改，请重新检查".into());
    }
    let p = model::parse(std::str::from_utf8(&session.last).map_err(error)?)?;
    let n = p
        .nodes
        .iter()
        .find(|n| n.id == node)
        .ok_or("节点不存在，请先保存节点")?;
    action(&session.root, n.linked_paths.as_deref().unwrap_or(&[]))
}
fn with_node_read<T>(
    store: &ProjectStore,
    token: &str,
    node: &str,
    action: impl FnOnce(&Path, &[String]) -> Result<T, String>,
) -> Result<T, String> {
    let session = project_io::read_session(store, token)?;
    project_io::check_path(&session)?;
    if !project_io::read_json_path_matches(&session)? {
        return Err("项目 JSON 已被外部更改，请重新检查".into());
    }
    let p = model::parse(std::str::from_utf8(&session.last).map_err(error)?)?;
    let n = p
        .nodes
        .iter()
        .find(|n| n.id == node)
        .ok_or("节点不存在，请先保存节点")?;
    action(&session.root, n.linked_paths.as_deref().unwrap_or(&[]))
}
pub(crate) fn resolve(root: &Path, stored: &str) -> Result<PathBuf, String> {
    if !model::valid_linked_path(stored) {
        return Err("外部关联路径格式无效".into());
    }
    let input = Path::new(stored);
    let mut path = if input.is_absolute() {
        PathBuf::new()
    } else {
        root.to_path_buf()
    };
    for part in input.components() {
        match part {
            Component::CurDir => (),
            Component::ParentDir => {
                if !path.pop() {
                    return Err("外部路径超出卷根目录".into());
                }
            }
            _ => path.push(part.as_os_str()),
        }
    }
    Ok(path)
}
fn identity(path: &Path) -> String {
    let real = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    project_io::display_directory(&real)
        .replace('\\', "/")
        .to_lowercase()
}
pub(crate) fn stored_path(root: &Path, target: &Path) -> String {
    let base: Vec<_> = root.components().collect();
    let dest: Vec<_> = target.components().collect();
    let common = base
        .iter()
        .zip(&dest)
        .take_while(|(a, b)| {
            a.as_os_str().to_string_lossy().to_lowercase()
                == b.as_os_str().to_string_lossy().to_lowercase()
        })
        .count();
    // Same drive / UNC share: retain portability, including sibling directories via '..'.
    if common >= 2 {
        let mut relative = PathBuf::new();
        for _ in common..base.len() {
            relative.push("..");
        }
        for part in &dest[common..] {
            relative.push(part.as_os_str());
        }
        if relative.as_os_str().is_empty() {
            ".".into()
        } else {
            relative.to_string_lossy().replace('\\', "/")
        }
    } else {
        {
            let absolute = project_io::display_directory(target).replace('\\', "/");
            if absolute.len() == 3 && absolute.as_bytes()[1] == b':' {
                absolute
            } else {
                absolute.trim_end_matches('/').to_string()
            }
        }
    }
}
pub fn normalize(
    store: &ProjectStore,
    token: &str,
    node: &str,
    selected: &[PathBuf],
    replace: Option<&str>,
) -> Result<Vec<String>, String> {
    with_node(store, token, node, |root, current| {
        if let Some(old) = replace {
            if !current.iter().any(|p| p == old) || selected.len() != 1 {
                return Err("待重新定位的关联已变化".into());
            }
        }
        let mut keys = HashSet::new();
        let mut result = Vec::new();
        for stored in current.iter().filter(|p| Some(p.as_str()) != replace) {
            if keys.insert(identity(&resolve(root, stored)?)) {
                result.push(stored.clone());
            }
        }
        for selected in selected {
            if !selected.is_absolute() {
                return Err("请选择绝对文件路径".into());
            }
            let target =
                fs::canonicalize(selected).map_err(|e| format!("无法关联所选路径：{e}"))?;
            let meta = fs::metadata(&target).map_err(error)?;
            if !meta.is_file() && !meta.is_dir() {
                return Err("仅支持普通文件和文件夹".into());
            }
            let stored = stored_path(root, &target);
            if !model::valid_linked_path(&stored) {
                return Err("路径包含不支持的名称或过长".into());
            }
            if keys.insert(identity(&target)) {
                result.push(stored);
            }
        }
        Ok(result)
    })
}
// Hold directories without FILE_SHARE_DELETE while enumerating, preventing junction replacement.
fn guard_directory(path: &Path) -> Result<fs::File, String> {
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
    let handle = options.open(path).map_err(error)?;
    let meta = handle.metadata().map_err(error)?;
    if !meta.is_dir() {
        return Err("关联目标不是文件夹".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("拒绝重解析点目录".into());
        }
    }
    Ok(handle)
}
fn entry(path: &Path, stored: String, name: String) -> Entry {
    let mut out = Entry {
        name,
        path: stored,
        is_directory: false,
        size: 0,
        status: "ok".into(),
        message: String::new(),
    };
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            let mut linked = meta.file_type().is_symlink();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                linked |= meta.file_attributes() & 0x400 != 0;
            }
            if linked {
                out.status = "blocked".into();
                out.message = "符号链接或重解析点不展开，请直接关联实际目标".into();
            } else if !meta.is_file() && !meta.is_dir() {
                out.status = "blocked".into();
                out.message = "不支持的文件类型".into();
            } else {
                out.is_directory = meta.is_dir();
                out.size = meta.len();
            }
        }
        Err(e) => {
            out.status = if e.kind() == std::io::ErrorKind::NotFound {
                "missing"
            } else {
                "unavailable"
            }
            .into();
            out.message = format!("无法访问：{e}");
        }
    }
    out
}
pub fn statuses(store: &ProjectStore, token: &str, node: &str) -> Result<Vec<Entry>, String> {
    with_node_read(store, token, node, |root, links| {
        links
            .iter()
            .map(|stored| {
                let path = resolve(root, stored)?;
                let name = path
                    .file_name()
                    .unwrap_or(path.as_os_str())
                    .to_string_lossy()
                    .into_owned();
                Ok(entry(&path, stored.clone(), name))
            })
            .collect()
    })
}
pub fn list(
    store: &ProjectStore,
    token: &str,
    node: &str,
    linked: &str,
    relative: &str,
) -> Result<Vec<Entry>, String> {
    with_node_read(store, token, node, |root, links| {
        if !links.iter().any(|p| p == linked) {
            return Err("此路径未关联到当前节点".into());
        }
        let parts: Vec<_> = if relative.is_empty() {
            vec![]
        } else {
            relative.split('/').collect()
        };
        if relative.len() > 4096
            || parts.len() > 32
            || parts.iter().any(|p| !model::valid_filename(p))
        {
            return Err("外部目录子路径无效，禁止路径穿越".into());
        }
        let base = resolve(root, linked)?;
        project_io::plain_path(&base)?;
        let boundary = fs::canonicalize(&base).map_err(error)?;
        let mut guards = vec![guard_directory(&boundary)?];
        let mut path = boundary.clone();
        for part in parts {
            path.push(part);
            guards.push(guard_directory(&path)?);
            if !fs::canonicalize(&path)
                .map_err(error)?
                .starts_with(&boundary)
            {
                return Err("目录超出关联边界".into());
            }
        }
        let mut result = Vec::new();
        for item in fs::read_dir(&path).map_err(|e| format!("读取外部文件夹失败：{e}"))? {
            let item = item.map_err(error)?;
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| "文件名不是有效 Unicode")?;
            if !model::valid_filename(&name) {
                return Err("目录含不支持的文件名".into());
            }
            let sub = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            result.push(entry(&item.path(), sub, name));
            if result.len() > 10_000 {
                return Err("单层目录超过10000项".into());
            }
        }
        result.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(result)
    })
}

pub(crate) fn with_target<T>(
    store: &ProjectStore,
    token: &str,
    node: &str,
    linked: &str,
    relative: &str,
    action: impl FnOnce(&Path, bool) -> Result<T, String>,
) -> Result<T, String> {
    with_node(store, token, node, |root, links| {
        if !links.iter().any(|p| p == linked) {
            return Err("此目标未关联到当前节点".into());
        }
        let parts: Vec<_> = if relative.is_empty() {
            vec![]
        } else {
            relative.split('/').collect()
        };
        if relative.len() > 4096
            || parts.len() > 32
            || parts.iter().any(|p| !model::valid_filename(p))
        {
            return Err("外部子路径无效，禁止目录穿越".into());
        }
        let base = resolve(root, linked)?;
        project_io::plain_path(&base)?;
        let boundary = fs::canonicalize(&base).map_err(error)?;
        let mut path = boundary.clone();
        let mut guards = vec![];
        if !parts.is_empty() {
            guards.push(guard_directory(&path)?);
        }
        for (i, part) in parts.iter().enumerate() {
            path.push(part);
            project_io::plain_path(&path)?;
            if !fs::canonicalize(&path)
                .map_err(error)?
                .starts_with(&boundary)
            {
                return Err("目标超出关联目录边界".into());
            }
            if i + 1 < parts.len() {
                guards.push(guard_directory(&path)?);
            }
        }
        let meta = fs::symlink_metadata(&path).map_err(error)?;
        if meta.is_dir() {
            guards.push(guard_directory(&path)?);
            action(&path, true)
        } else {
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x00200000).share_mode(1 | 2);
            }
            let file = options.open(&path).map_err(error)?;
            let meta = file.metadata().map_err(error)?;
            if !meta.is_file() {
                return Err("不是普通文件".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("拒绝重解析点文件".into());
                }
            }
            action(&path, false)
        }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        temp: tempfile::TempDir,
        store: ProjectStore,
        token: String,
        path: PathBuf,
        folder: PathBuf,
        file: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let folder = temp.path().join("external");
            fs::create_dir(&folder).unwrap();
            fs::create_dir(folder.join("nested")).unwrap();
            fs::write(folder.join("nested/deep.txt"), "deep").unwrap();
            let file = folder.join("note.txt");
            fs::write(&file, "external original").unwrap();
            let store = ProjectStore::default();
            let opened = project_io::create(&store, temp.path(), model::sample()).unwrap();
            let mut json: serde_json::Value = serde_json::from_str(&opened.json).unwrap();
            json["nodes"] = serde_json::json!([
                {"id":"a","title":"A","parentId":null,"weight":0,"progress":73,"color":null},
                {"id":"b","title":"B","parentId":"a","weight":1,"progress":40,"color":null}
            ]);
            json["views"]["tree"]["positions"] = serde_json::json!({"a":{"x":0,"y":0},"b":{"x":300,"y":0}});
            project_io::save(&store, &opened.token, &json.to_string()).unwrap();
            Self {
                temp,
                store,
                token: opened.token,
                path: opened.path.into(),
                folder,
                file,
            }
        }
        fn save_links(&self, node: usize, links: &[String]) {
            let mut json: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&self.path).unwrap()).unwrap();
            if links.is_empty() {
                json["nodes"][node]
                    .as_object_mut()
                    .unwrap()
                    .remove("linkedPaths");
            } else {
                json["nodes"][node]["linkedPaths"] = serde_json::json!(links);
            }
            project_io::save(&self.store, &self.token, &json.to_string()).unwrap();
        }
        fn link(&self) -> Vec<String> {
            normalize(
                &self.store,
                &self.token,
                "a",
                &[self.file.clone(), self.folder.clone()],
                None,
            )
            .unwrap()
        }
    }
    #[test]
    fn mixed_relative_links_roundtrip_reopen_and_independent_nodes() {
        let f = Fixture::new();
        assert!(statuses(&f.store, &f.token, "a").unwrap().is_empty());
        let links = f.link();
        assert_eq!(links, ["../external/note.txt", "../external"]);
        f.save_links(0, &links);
        f.save_links(1, &links);
        let opened = project_io::open(&f.store, &f.path).unwrap();
        for node in ["a", "b"] {
            let entries = statuses(&f.store, &opened.token, node).unwrap();
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[0].status, "ok");
            assert!(!entries[0].is_directory);
            assert!(entries[1].is_directory);
        }
        let p = model::parse(&opened.json).unwrap();
        assert_eq!(p.nodes[0].progress, 73.0);
        assert_eq!(p.nodes[0].weight, 0.0);
        assert!(!f.path.parent().unwrap().join("Nodes").exists());
    }
    #[test]
    fn canonical_spelling_case_and_absolute_relative_dedup() {
        let f = Fixture::new();
        let links = f.link();
        f.save_links(0, &links);
        let alias = f.folder.join("nested/../note.txt");
        assert_eq!(
            normalize(
                &f.store,
                &f.token,
                "a",
                &[alias, f.file.clone(), f.folder.clone()],
                None
            )
            .unwrap(),
            links
        );
        #[cfg(windows)]
        {
            let case = PathBuf::from(f.file.to_string_lossy().to_uppercase());
            assert_eq!(
                normalize(&f.store, &f.token, "a", &[case], None).unwrap(),
                links
            );
        }
    }
    #[test]
    fn lazy_direct_children_only_and_missing_status_retained() {
        let f = Fixture::new();
        let links = f.link();
        f.save_links(0, &links);
        let entries = list(&f.store, &f.token, "a", &links[1], "").unwrap();
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["nested", "note.txt"]
        );
        assert_eq!(
            list(&f.store, &f.token, "a", &links[1], "nested").unwrap()[0].path,
            "nested/deep.txt"
        );
        fs::remove_file(&f.file).unwrap();
        let entries = statuses(&f.store, &f.token, "a").unwrap();
        assert_eq!(entries[0].status, "missing");
        assert_eq!(entries[0].path, links[0]);
        let p = model::parse(&fs::read_to_string(&f.path).unwrap()).unwrap();
        assert_eq!(p.nodes[0].linked_paths.as_ref().unwrap(), &links);
    }
    #[test]
    fn unlink_relocate_and_delete_node_never_modify_external_targets() {
        let f = Fixture::new();
        let links = f.link();
        f.save_links(0, &links);
        let before = fs::metadata(&f.file).unwrap().modified().unwrap();
        let replacement = f.temp.path().join("replacement.txt");
        fs::write(&replacement, "replacement").unwrap();
        let relocated = normalize(
            &f.store,
            &f.token,
            "a",
            std::slice::from_ref(&replacement),
            Some(&links[0]),
        )
        .unwrap();
        assert_eq!(relocated, ["../external", "../replacement.txt"]);
        f.save_links(0, &relocated);
        f.save_links(0, &[]);
        let mut p: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&f.path).unwrap()).unwrap();
        assert!(p["nodes"][0].get("linkedPaths").is_none());
        p["nodes"] = serde_json::json!([]);
        p["views"]["tree"]["positions"] = serde_json::json!({});
        project_io::save(&f.store, &f.token, &p.to_string()).unwrap();
        assert_eq!(fs::read_to_string(&f.file).unwrap(), "external original");
        assert_eq!(fs::metadata(&f.file).unwrap().modified().unwrap(), before);
        assert_eq!(fs::read_to_string(&replacement).unwrap(), "replacement");
        assert_eq!(
            fs::read_to_string(f.folder.join("nested/deep.txt")).unwrap(),
            "deep"
        );
    }
    #[test]
    fn rejects_unauthorized_unlinked_traversal_device_and_malformed_model() {
        let f = Fixture::new();
        let links = f.link();
        f.save_links(0, &links);
        assert!(statuses(&f.store, "bad", "a").is_err());
        assert!(statuses(&f.store, &f.token, "missing").is_err());
        assert!(list(&f.store, &f.token, "b", &links[1], "").is_err());
        for path in [
            "../",
            "nested/../../",
            "C:/Windows",
            "nested\\deep.txt",
            "/",
            "nested//other",
            "nested/.",
            "a:stream",
        ] {
            assert!(
                list(&f.store, &f.token, "a", &links[1], path).is_err(),
                "{path}"
            );
        }
        for path in [
            "",
            "C:relative",
            "//?/C:/Windows",
            "//./C:/Windows",
            "a:stream",
            "x\n",
            "NUL",
            "/Windows",
            "a//b",
        ] {
            assert!(!model::valid_linked_path(path), "{path}");
        }
        assert!(normalize(&f.store, &f.token, "a", &[PathBuf::from("relative")], None).is_err());
        assert!(normalize(
            &f.store,
            &f.token,
            "a",
            &[f.temp.path().join("absent")],
            None
        )
        .is_err());
        assert!(normalize(
            &f.store,
            &f.token,
            "a",
            &[f.file.clone()],
            Some("not-linked")
        )
        .is_err());
        let mut p: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&f.path).unwrap()).unwrap();
        for bad in [
            serde_json::json!(null),
            serde_json::json!([]),
            serde_json::json!("x"),
            serde_json::json!([42]),
            serde_json::json!(["x", "./X"]),
        ] {
            p["nodes"][0]["linkedPaths"] = bad;
            assert!(model::parse(&p.to_string()).is_err());
        }
    }
    #[test]
    fn existing_absolute_missing_link_is_retained_and_deduped_when_available() {
        let f = Fixture::new();
        let absolute =
            project_io::display_directory(&fs::canonicalize(&f.file).unwrap()).replace('\\', "/");
        f.save_links(0, std::slice::from_ref(&absolute));
        assert_eq!(
            normalize(&f.store, &f.token, "a", &[f.file.clone()], None).unwrap(),
            [absolute]
        );
        fs::write(&f.path, "externally changed").unwrap();
        assert!(statuses(&f.store, &f.token, "a").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn cross_drive_storage_and_unc_are_absolute_and_valid() {
        assert_eq!(
            stored_path(Path::new(r"\\?\C:\Forest"), Path::new(r"\\?\D:\Docs\a.txt")),
            "D:/Docs/a.txt"
        );
        assert!(model::valid_linked_path("//server/share/folder"));
        assert_eq!(
            stored_path(
                Path::new(r"\\?\UNC\server\one\Forest"),
                Path::new(r"\\?\UNC\server\two\Docs")
            ),
            "//server/two/Docs"
        );
    }
    #[cfg(windows)]
    #[test]
    fn junction_children_and_replaced_link_root_are_blocked() {
        let f = Fixture::new();
        let links = f.link();
        f.save_links(0, &links);
        let junction = f.folder.join("escape");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(f.path.parent().unwrap())
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        let entries = list(&f.store, &f.token, "a", &links[1], "").unwrap();
        assert_eq!(
            entries.iter().find(|e| e.name == "escape").unwrap().status,
            "blocked"
        );
        assert!(list(&f.store, &f.token, "a", &links[1], "escape").is_err());
        fs::remove_dir(&junction).unwrap();
    }
}

#[cfg(all(test, windows))]
mod sharing_tests {
    use super::*;
    #[test]
    fn locked_external_directory_reports_error_and_retries_without_changes() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("external");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("note.txt"), "original").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .share_mode(0)
            .open(&folder)
            .unwrap();
        assert!(guard_directory(&folder).is_err());
        drop(lock);
        assert!(guard_directory(&folder).is_ok());
        assert_eq!(
            fs::read_to_string(folder.join("note.txt")).unwrap(),
            "original"
        );
    }
}

/// Only a newly selected file may be written; existing external files are never adopted/overwritten.
pub fn create_selected(
    store: &ProjectStore,
    token: &str,
    node: &str,
    selected: &Path,
    extension: &str,
) -> Result<Vec<String>, String> {
    if !matches!(extension, "txt" | "md") {
        return Err("仅支持 TXT 或 Markdown".into());
    }
    let mut selected = selected.to_path_buf();
    if selected.extension().and_then(|s| s.to_str()) != Some(extension) {
        selected.set_extension(extension);
    }
    let parent = fs::canonicalize(selected.parent().ok_or("保存位置无父目录")?).map_err(error)?;
    let name = selected
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("文件名无效")?;
    if !model::valid_filename(name) {
        return Err("文件名不安全".into());
    }
    let target = parent.join(name);
    with_node(store, token, node, |_, _| {
        let _guard = guard_directory(&parent)?;
        for entry in fs::read_dir(&parent).map_err(error)? {
            if entry
                .map_err(error)?
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                == name.to_lowercase()
            {
                return Err("目标已存在，不会覆盖外部文件".into());
            }
        }
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(error)?;
        file.sync_all().map_err(error)
    })?;
    normalize(store, token, node, &[target.clone()], None).map_err(|e| {
        format!(
            "文件已创建于 {}，但关联未完成，请重新关联：{e}",
            project_io::display_directory(&target)
        )
    })
}

#[cfg(test)]
mod card_create_tests {
    use super::*;
    #[test]
    fn external_read_releases_save_mutex() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = project_io::create(&store, temp.path(), model::sample()).unwrap();
        let mut p: serde_json::Value = serde_json::from_str(&opened.json).unwrap();
        p["nodes"] = serde_json::json!([{"id":"a","title":"A","parentId":null,"progress":0,"weight":1,"color":null}]);
        p["views"]["tree"]["positions"] = serde_json::json!({"a":{"x":0,"y":0}});
        project_io::save(&store, &opened.token, &p.to_string()).unwrap();
        with_node_read(&store, &opened.token, "a", |_, _| {
            let lock = store
                .0
                .try_lock()
                .expect("slow external read must not block save");
            drop(lock);
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn external_create_uses_selected_location_and_does_not_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = project_io::create(&store, temp.path(), model::sample()).unwrap();
        let mut p: serde_json::Value = serde_json::from_str(&opened.json).unwrap();
        p["nodes"] = serde_json::json!([{"id":"a","title":"A","parentId":null,"progress":73,"weight":0,"color":null}]);
        p["views"]["tree"]["positions"] = serde_json::json!({"a":{"x":0,"y":0}});
        project_io::save(&store, &opened.token, &p.to_string()).unwrap();
        let target = temp.path().join("外部 新建.txt");
        let paths = create_selected(&store, &opened.token, "a", &target, "txt").unwrap();
        assert_eq!(paths, ["../外部 新建.txt"]);
        assert!(target.exists());
        fs::write(&target, "do not overwrite").unwrap();
        assert!(create_selected(&store, &opened.token, "a", &target, "txt").is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "do not overwrite");
        assert!(create_selected(&store, "bad", "a", &temp.path().join("bad.txt"), "txt").is_err());
        assert!(!temp.path().join("bad.txt").exists());
        assert!(create_selected(
            &store,
            &opened.token,
            "a",
            &temp.path().join("bad.exe"),
            "exe"
        )
        .is_err());
        let md = temp.path().join("Markdown.md");
        assert_eq!(
            create_selected(&store, &opened.token, "a", &md, "md").unwrap(),
            ["../Markdown.md"]
        );
        p["nodes"][0]["linkedPaths"] = serde_json::json!(paths);
        project_io::save(&store, &opened.token, &p.to_string()).unwrap();
        let reopened = project_io::open(&store, Path::new(&opened.path)).unwrap();
        assert_eq!(
            model::parse(&reopened.json).unwrap().nodes[0]
                .linked_paths
                .as_ref()
                .unwrap()[0],
            "../外部 新建.txt"
        );
        assert!(!Path::new(&opened.path)
            .parent()
            .unwrap()
            .join("Nodes")
            .exists());
    }
}
