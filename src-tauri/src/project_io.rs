use crate::model::{parse, valid_filename};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const MAX_JSON_BYTES: u64 = 32 * 1024 * 1024;
#[derive(Default)]
pub struct ProjectStore(pub Mutex<HashMap<String, Session>>);
#[derive(Clone)]
pub struct Session {
    pub(crate) root: PathBuf,
    path: PathBuf,
    project_id: String,
    pub(crate) last: Vec<u8>,
    pub(crate) known_node_ids: HashSet<String>,
}
#[derive(Serialize)]
pub struct OpenedProject {
    pub token: String,
    pub path: String,
    pub directory: String,
    pub json: String,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub(crate) fn plain_path(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(error)?;
    if meta.file_type().is_symlink() {
        return Err("拒绝符号链接项目路径".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("拒绝重解析点项目路径".into());
        }
    }
    Ok(())
}
pub(crate) fn read_json(path: &Path) -> Result<String, String> {
    plain_path(path)?;
    let meta = fs::metadata(path).map_err(error)?;
    if !meta.is_file() || meta.len() > MAX_JSON_BYTES {
        return Err("不是文件或项目 JSON 超过 32 MiB".into());
    }
    fs::read_to_string(path).map_err(error)
}
pub(crate) fn read_json_path_matches(session: &Session) -> Result<bool, String> {
    Ok(read_json(&session.path)?.as_bytes() == session.last)
}
pub(crate) fn check_path(session: &Session) -> Result<(), String> {
    plain_path(&session.root)?;
    plain_path(&session.path)?;
    if fs::canonicalize(&session.root).map_err(error)? != session.root
        || fs::canonicalize(&session.path).map_err(error)? != session.path
    {
        return Err("项目目录已移动或指向发生变化，请重新打开".into());
    }
    Ok(())
}
/// A same-volume temporary file is synced before replacing the destination.
/// `persist` is an atomic rename/replace; failures never open the old JSON with truncate.
fn atomic_write(
    path: &Path,
    json: &str,
    create: bool,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let root = path.parent().ok_or("项目路径缺少目录")?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".forest-")
        .suffix(".tmp")
        .tempfile_in(root)
        .map_err(error)?;
    tmp.write_all(json.as_bytes()).map_err(error)?;
    tmp.as_file().sync_all().map_err(error)?;
    before_commit()?;
    let committed = if create {
        tmp.persist_noclobber(path)
    } else {
        tmp.persist(path)
    };
    committed.map_err(|e| format!("项目替换失败，内存草稿保留：{}", e.error))?;
    Ok(())
}
fn register(store: &ProjectStore, path: PathBuf, json: String) -> Result<OpenedProject, String> {
    let p = parse(&json)?;
    let root = path.parent().ok_or("项目路径无目录")?.to_path_buf();
    let mut sessions = store.0.lock().map_err(error)?;
    let token = Uuid::new_v4().to_string();
    sessions.insert(
        token.clone(),
        Session {
            root,
            path: path.clone(),
            known_node_ids: p.nodes.iter().map(|n| n.id.clone()).collect(),
            project_id: p.project_id,
            last: json.as_bytes().to_vec(),
        },
    );
    Ok(OpenedProject {
        token,
        directory: display_directory(path.parent().ok_or("项目路径无目录")?),
        path: path.to_string_lossy().into_owned(),
        json,
    })
}
pub fn display_directory(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned()
    }
}
pub fn directory(store: &ProjectStore, token: &str) -> Result<PathBuf, String> {
    let sessions = store.0.lock().map_err(error)?;
    let session = sessions.get(token).ok_or("未授权的项目会话")?;
    check_path(session)?;
    Ok(session.root.clone())
}
pub fn create(store: &ProjectStore, parent: &Path, json: String) -> Result<OpenedProject, String> {
    let p = parse(&json)?;
    if !p.nodes.is_empty() || !valid_filename(&p.name) {
        return Err("新项目名称不能含 Windows 非法字符、保留名或末尾点/空格".into());
    }
    let parent = fs::canonicalize(parent).map_err(error)?;
    plain_path(&parent)?;
    let root = parent.join(&p.name);
    // Exclusive directory creation: never adopt or overwrite an existing user directory.
    fs::create_dir(&root).map_err(|e| format!("创建目录失败（同名目录不会覆盖）：{e}"))?;
    let root = fs::canonicalize(&root).map_err(error)?;
    let path = root.join(format!("{}.json", p.name));
    atomic_write(&path, &json, true, || Ok(()))?;
    register(store, fs::canonicalize(path).map_err(error)?, json)
}
pub fn open(store: &ProjectStore, selected: &Path) -> Result<OpenedProject, String> {
    if !selected.is_absolute() {
        return Err("项目路径必须为绝对路径".into());
    }
    plain_path(selected)?;
    let path = fs::canonicalize(selected).map_err(error)?;
    let json = read_json(&path)?;
    register(store, path, json)
}
pub fn save(store: &ProjectStore, token: &str, json: &str) -> Result<(), String> {
    let p = parse(json)?;
    if json.len() as u64 > MAX_JSON_BYTES {
        return Err("项目 JSON 超过 32 MiB".into());
    }
    // The lock serializes all writes, including a save still running when the frontend retries.
    let mut sessions = store.0.lock().map_err(error)?;
    let session = sessions
        .get_mut(token)
        .ok_or("未授权的项目会话；请从系统对话框打开项目")?;
    if p.project_id != session.project_id {
        return Err("拒绝变更项目身份".into());
    }
    check_path(session)?;
    let previous = parse(std::str::from_utf8(&session.last).map_err(error)?)?;
    crate::internal_files::protect_changes(&session.root, &previous, &p, &session.known_node_ids)?;
    atomic_write(&session.path, json, false, || {
        check_path(session)?;
        if read_json(&session.path)?.as_bytes() != session.last {
            return Err(
                "磁盘文件已被外部更改，停止保存以保护原文件。请保留本窗口并处理冲突。".into(),
            );
        }
        Ok(())
    })?;
    session
        .known_node_ids
        .extend(p.nodes.iter().map(|n| n.id.clone()));
    session.last = json.as_bytes().to_vec();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::sample;
    #[test]
    fn directory_is_real_token_scoped_and_missing_root_is_not_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), sample()).unwrap();
        let root = directory(&store, &opened.token).unwrap();
        assert_eq!(opened.directory, display_directory(&root));
        assert!(directory(&store, "invalid").is_err());
        let moved = temp.path().join("moved");
        fs::rename(&root, &moved).unwrap();
        assert!(directory(&store, &opened.token).is_err());
        assert!(!root.exists());
        assert!(moved.exists());
        assert_eq!(display_directory(Path::new(r"\\?\C:\Forest")), r"C:\Forest");
        assert_eq!(
            display_directory(Path::new(r"\\?\UNC\server\share\Forest")),
            r"\\server\share\Forest"
        );
    }
    #[test]
    fn create_save_reopen_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), sample()).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&opened.json).unwrap();
        v["views"]["tree"]["viewport"] = serde_json::json!({"x":123.25,"y":-80,"zoom":0.75});
        save(&store, &opened.token, &v.to_string()).unwrap();
        let reopened = open(&store, Path::new(&opened.path)).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&reopened.json).unwrap(),
            v
        );
    }
    #[test]
    fn injected_failure_preserves_previous_json() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("project.json");
        let original = sample();
        fs::write(&path, &original).unwrap();
        assert!(atomic_write(&path, &sample(), false, || Err(
            "injected before commit".into()
        ))
        .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }
    #[test]
    fn rename_failure_preserves_destination() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("existing-directory");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("sentinel"), "preserved").unwrap();
        assert!(atomic_write(&path, &sample(), false, || Ok(())).is_err());
        assert_eq!(
            fs::read_to_string(path.join("sentinel")).unwrap(),
            "preserved"
        );
    }
    #[test]
    fn invalid_json_and_external_change_never_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), sample()).unwrap();
        assert!(save(&store, &opened.token, "{}").is_err());
        assert_eq!(fs::read_to_string(&opened.path).unwrap(), opened.json);
        fs::write(&opened.path, "external content").unwrap();
        assert!(save(&store, &opened.token, &opened.json).is_err());
        assert_eq!(
            fs::read_to_string(&opened.path).unwrap(),
            "external content"
        );
    }
    #[test]
    fn damaged_future_unauthorized_and_duplicate_directory_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), sample()).unwrap();
        assert!(create(&store, temp.path(), opened.json.clone()).is_err());
        assert!(save(&store, "bad-token", &opened.json).is_err());
        fs::write(&opened.path, "{damaged").unwrap();
        assert!(open(&store, Path::new(&opened.path)).is_err());
        assert_eq!(fs::read_to_string(&opened.path).unwrap(), "{damaged");
        fs::write(
            &opened.path,
            opened
                .json
                .replace("\"version\":3", "\"version\":99"),
        )
        .unwrap();
        assert!(open(&store, Path::new(&opened.path)).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_locked_target_preserves_valid_json() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), sample()).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&opened.path)
            .unwrap();
        assert!(save(&store, &opened.token, &opened.json).is_err());
        assert_eq!(fs::read_to_string(&opened.path).unwrap(), opened.json);
        drop(lock);
    }
}

// Clone authorization state briefly; slow read-only directory I/O must not hold the save mutex.
pub(crate) fn read_session(store: &ProjectStore, token: &str) -> Result<Session, String> {
    let sessions = store.0.lock().map_err(error)?;
    sessions
        .get(token)
        .cloned()
        .ok_or_else(|| "未授权的项目会话".into())
}

/// Rename only a dedicated forest directory; publish the new JSON before moving it.
pub fn rename(store: &ProjectStore, token: &str, name: &str) -> Result<OpenedProject, String> {
    rename_with_hook(store, token, name, || Ok(()))
}
fn rename_with_hook(
    store: &ProjectStore,
    token: &str,
    name: &str,
    before_remove: impl FnOnce() -> Result<(), String>,
) -> Result<OpenedProject, String> {
    if !valid_filename(name) {
        return Err("项目名称无效".into());
    }
    let mut sessions = store.0.lock().map_err(error)?;
    let session = sessions.get(token).ok_or("未授权的项目会话")?.clone();
    check_path(&session)?;
    if !read_json_path_matches(&session)? {
        return Err("磁盘项目已更改，取消重命名".into());
    }
    let mut project = parse(std::str::from_utf8(&session.last).map_err(error)?)?;
    if sessions
        .iter()
        .any(|(key, s)| key != token && s.root == session.root)
    {
        return Err("其他会话正在使用项目".into());
    }
    if session.root.file_name().and_then(|s| s.to_str()) != Some(project.name.as_str())
        || session.path.file_name().and_then(|s| s.to_str())
            != Some(format!("{}.json", project.name).as_str())
    {
        return Err("目录或JSON名称不匹配，不能确认专属项目目录".into());
    }
    for entry in fs::read_dir(&session.root).map_err(error)? {
        let entry = entry.map_err(error)?;
        plain_path(&entry.path())?;
        if entry.path() != session.path
            && !(entry.file_name() == "Nodes" && entry.file_type().map_err(error)?.is_dir())
        {
            return Err("项目目录包含其他文件，拒绝重命名整个目录".into());
        }
    }
    let nodes = session.root.join("Nodes");
    if nodes.exists() {
        for entry in fs::read_dir(&nodes).map_err(error)? {
            let entry = entry.map_err(error)?;
            plain_path(&entry.path())?;
            if !entry.file_type().map_err(error)?.is_dir()
                || !crate::model::valid_node_id(&entry.file_name().to_string_lossy())
            {
                return Err("Nodes包含非项目节点目录，取消重命名".into());
            }
        }
        let mut pending = vec![nodes];
        let mut count = 0;
        while let Some(dir) = pending.pop() {
            for entry in fs::read_dir(dir).map_err(error)? {
                let entry = entry.map_err(error)?;
                count += 1;
                if count > 100_000 {
                    return Err("项目过大，取消目录安全检查".into());
                }
                plain_path(&entry.path())?;
                if entry.file_type().map_err(error)?.is_dir() {
                    pending.push(entry.path());
                }
            }
        }
    }
    if name == project.name {
        return Ok(OpenedProject {
            token: token.into(),
            path: session.path.to_string_lossy().into_owned(),
            directory: display_directory(&session.root),
            json: String::from_utf8(session.last).map_err(error)?,
        });
    }
    let destination = session.root.parent().ok_or("项目没有父目录")?.join(name);
    if destination.exists() {
        return Err("同名目录已存在，不会覆盖".into());
    }
    for node in &mut project.nodes {
        if let Some(paths) = &mut node.linked_paths {
            for link in paths {
                let old = crate::external_files::resolve(&session.root, link)?;
                let target = if let Ok(rest) = old.strip_prefix(&session.root) {
                    destination.join(rest)
                } else {
                    old
                };
                *link = crate::external_files::stored_path(&destination, &target);
            }
        }
    }
    project.name = name.into();
    let json = serde_json::to_string_pretty(&project).map_err(error)?;
    parse(&json)?;
    let staged = session.root.join(format!("{name}.json"));
    atomic_write(&staged, &json, true, || {
        check_path(&session)?;
        if !read_json_path_matches(&session)? || destination.exists() {
            return Err("项目状态变化，取消重命名".into());
        }
        Ok(())
    })?;
    if let Err(e) = fs::rename(&session.root, &destination) {
        let _ = fs::remove_file(&staged);
        return Err(format!("目录重命名失败，原项目保留：{e}"));
    }
    let new_path = destination.join(format!("{name}.json"));
    let old_path = destination.join(session.path.file_name().ok_or("项目文件名无效")?);
    if let Err(e) = before_remove().and_then(|_| fs::remove_file(&old_path).map_err(error)) {
        if fs::rename(&destination, &session.root).is_ok() {
            let _ = fs::remove_file(&staged);
            return Err(format!("重命名已回滚：{e}"));
        }
        sessions.remove(token);
        return Err(format!(
            "重命名回滚失败，文件仍保留在 {}；请重新打开其中的JSON，当前会话已禁止写入",
            display_directory(&destination)
        ));
    }
    let root = fs::canonicalize(destination).map_err(error)?;
    let path = fs::canonicalize(new_path).map_err(error)?;
    let next = Uuid::new_v4().to_string();
    sessions.remove(token);
    sessions.insert(
        next.clone(),
        Session {
            root: root.clone(),
            path: path.clone(),
            known_node_ids: session.known_node_ids,
            project_id: project.project_id,
            last: json.as_bytes().to_vec(),
        },
    );
    Ok(OpenedProject {
        token: next,
        path: path.to_string_lossy().into_owned(),
        directory: display_directory(&root),
        json,
    })
}

#[cfg(test)]
mod rename_tests {
    use super::*;
    #[test]
    fn rename_preserves_identity_files_and_external_targets() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), crate::model::sample()).unwrap();
        let old = PathBuf::from(&opened.path);
        let root = old.parent().unwrap();
        let original = parse(&opened.json).unwrap();
        let external = temp.path().join("outside.txt");
        fs::write(&external, "untouched").unwrap();
        let mut project = original.clone();
        if let Some(n) = project.nodes.first_mut() {
            n.linked_paths = Some(vec!["../outside.txt".into()]);
        }
        save(
            &store,
            &opened.token,
            &serde_json::to_string(&project).unwrap(),
        )
        .unwrap();
        let renamed = rename(&store, &opened.token, "Renamed 项目").unwrap();
        let after = parse(&renamed.json).unwrap();
        assert_eq!(after.project_id, original.project_id);
        assert_eq!(after.nodes.len(), original.nodes.len());
        assert!(!root.exists());
        assert_eq!(fs::read_to_string(external).unwrap(), "untouched");
        assert!(open(&store, Path::new(&renamed.path)).is_ok());
    }
    #[test]
    fn rename_rejects_other_files_conflict_and_invalid_names_without_changes() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), crate::model::sample()).unwrap();
        let path = PathBuf::from(&opened.path);
        let before = fs::read(&path).unwrap();
        assert!(rename(&store, &opened.token, "../escape").is_err());
        fs::create_dir(temp.path().join("taken")).unwrap();
        assert!(rename(&store, &opened.token, "taken").is_err());
        fs::write(path.parent().unwrap().join("personal.txt"), "personal").unwrap();
        assert!(rename(&store, &opened.token, "safe").is_err());
        assert_eq!(fs::read(path).unwrap(), before);
    }
}

#[cfg(test)]
mod rename_safety_tests {
    use super::*;
    #[test]
    fn internal_files_and_relative_targets_follow_successful_rename() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), crate::model::sample()).unwrap();
        let root = directory(&store, &opened.token).unwrap();
        fs::write(temp.path().join("outside.txt"), "external").unwrap();
        let mut p = parse(&opened.json).unwrap();
        p.nodes.push(crate::model::Node {
            id: "a".into(),
            title: "A".into(),
            parent_id: None,
            progress: 73.,
            weight: 0.,
            color: None,
            linked_paths: Some(vec![
                "../outside.txt".into(),
                format!("../{}/Nodes/a/readme.md", p.name),
                "../missing.txt".into(),
            ]),
        });
        p.views.tree.positions.insert("a".into(), crate::model::Point { x: 5., y: 8. });
        p.views.tree.collapsed_ids.push("a".into());
        save(&store, &opened.token, &serde_json::to_string(&p).unwrap()).unwrap();
        fs::create_dir_all(root.join("Nodes/a")).unwrap();
        fs::write(root.join("Nodes/a/readme.md"), "internal").unwrap();
        let next = rename(&store, &opened.token, "Renamed").unwrap();
        let n = parse(&next.json).unwrap();
        let next_root = directory(&store, &next.token).unwrap();
        assert_eq!(
            fs::read_to_string(next_root.join("Nodes/a/readme.md")).unwrap(),
            "internal"
        );
        assert_eq!(n.nodes[0].progress, 73.);
        assert_eq!(n.nodes[0].id, "a");
        assert_eq!(n.project_id, p.project_id);
        let paths = n.nodes[0].linked_paths.as_ref().unwrap();
        assert_eq!(
            crate::external_files::resolve(&next_root, &paths[0]).unwrap(),
            temp.path().canonicalize().unwrap().join("outside.txt")
        );
        assert_eq!(
            crate::external_files::resolve(&next_root, &paths[1]).unwrap(),
            next_root.join("Nodes/a/readme.md")
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("outside.txt")).unwrap(),
            "external"
        );
    }
    #[test]
    fn failed_json_cleanup_rolls_back_folder_and_keeps_old_valid_json() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), crate::model::sample()).unwrap();
        let before = fs::read(&opened.path).unwrap();
        assert!(rename_with_hook(&store, &opened.token, "Changed", || Err(
            "injected cleanup failure".into()
        ))
        .is_err());
        assert_eq!(fs::read(&opened.path).unwrap(), before);
        assert!(!temp.path().join("Changed").exists());
        assert!(directory(&store, &opened.token).is_ok());
    }
}

#[cfg(test)]
mod recent_open_tests {
    use super::*;
    #[test]
    fn absolute_recent_path_reuses_validation_and_never_creates_missing_or_damaged_projects() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let created = create(&store, temp.path(), crate::model::sample()).unwrap();
        let before = fs::read(&created.path).unwrap();
        let reopened = open(&store, Path::new(&created.path)).unwrap();
        assert_eq!(
            parse(&reopened.json).unwrap().project_id,
            parse(&created.json).unwrap().project_id
        );
        assert_eq!(fs::read(&created.path).unwrap(), before);
        assert!(open(&store, Path::new("relative.json")).is_err());
        let missing = temp.path().join("不存在 空格.json");
        assert!(open(&store, &missing).is_err());
        assert!(!missing.exists());
        let broken = temp.path().join("损坏.json");
        fs::write(&broken, b"{broken").unwrap();
        assert!(open(&store, &broken).is_err());
        assert_eq!(fs::read(&broken).unwrap(), b"{broken");
        assert_eq!(fs::read(&created.path).unwrap(), before);
    }
    #[test]
    fn v3_save_reopen_rename_preserves_views_and_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), crate::model::sample()).unwrap();
        let mut fixture: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/project-v3.json")).unwrap();
        let initial = parse(&opened.json).unwrap();
        fixture["projectId"] = initial.project_id.into();
        fixture["name"] = initial.name.into();
        let json = fixture.to_string();
        save(&store, &opened.token, &json).unwrap();
        let root = directory(&store, &opened.token).unwrap();
        fs::create_dir_all(root.join("Nodes/a")).unwrap();
        fs::write(root.join("Nodes/a/内部 文件.txt"), "keep").unwrap();
        let reopened = open(&store, Path::new(&opened.path)).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&reopened.json).unwrap(), fixture);
        store.0.lock().unwrap().remove(&opened.token);
        let renamed = rename(&store, &reopened.token, "V3 重命名").unwrap();
        let after: serde_json::Value = serde_json::from_str(&renamed.json).unwrap();
        assert_eq!(parse(&renamed.json).unwrap().views, parse(&json).unwrap().views);
        assert_eq!(after["projectId"], fixture["projectId"]);
        assert_eq!(fs::read_to_string(directory(&store, &renamed.token).unwrap().join("Nodes/a/内部 文件.txt")).unwrap(), "keep");
    }
    #[test]
    fn old_versions_never_open_migrate_or_overwrite_valid_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProjectStore::default();
        let opened = create(&store, temp.path(), crate::model::sample()).unwrap();
        let before = fs::read(&opened.path).unwrap();
        let legacy = r#"{"format":"forest-project","schemaVersion":2,"nodes":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        assert!(save(&store, &opened.token, legacy).unwrap_err().contains("仅支持 V3"));
        assert_eq!(fs::read(&opened.path).unwrap(), before);
        let old = temp.path().join("old-v2.json");
        fs::write(&old, legacy).unwrap();
        assert!(open(&store, &old).err().unwrap().contains("仅支持 V3"));
        assert_eq!(fs::read_to_string(old).unwrap(), legacy);
    }

}
