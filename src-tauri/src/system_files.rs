//! Shell actions accept only node-relative/linked targets, never arbitrary frontend paths.
use crate::{
    external_files, internal_files,
    project_io::{self, ProjectStore},
};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(tag = "source", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    Internal { relative: String },
    External { linked: String, relative: String },
}
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Path,
    Open,
    Reveal,
}

pub fn run(
    store: &ProjectStore,
    token: &str,
    node: &str,
    target: &Target,
    action: Action,
) -> Result<String, String> {
    dispatch(store, token, node, target, action, native)
}
fn dispatch(
    store: &ProjectStore,
    token: &str,
    node: &str,
    target: &Target,
    action: Action,
    launch: impl FnOnce(&Path, bool, Action) -> Result<(), String>,
) -> Result<String, String> {
    let apply = |path: &Path, directory: bool| {
        if action == Action::Open && directory {
            return Err("文件夹仅在文件树中展开；请使用资源管理器菜单打开目录".into());
        }
        if action != Action::Path {
            launch(path, directory, action)?;
        }
        Ok(project_io::display_directory(path))
    };
    match target {
        Target::Internal { relative } => {
            internal_files::with_target(store, token, node, relative, apply)
        }
        Target::External { linked, relative } => {
            external_files::with_target(store, token, node, linked, relative, apply)
        }
    }
}
fn native(path: &Path, directory: bool, action: Action) -> Result<(), String> {
    #[cfg(windows)]
    {
        let path = project_io::display_directory(path);
        // Shell extensions may require STA. Use a fresh thread, with balanced COM lifetime.
        std::thread::spawn(move || windows::perform(&path, directory, action))
            .join()
            .map_err(|_| "Windows 文件操作线程异常".to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (path, directory, action);
        Err("系统文件操作目前仅支持 Windows".into())
    }
}
#[cfg(windows)]
mod windows {
    use super::Action;
    use std::{
        ffi::c_void,
        ptr::{null, null_mut},
    };
    #[repr(C)]
    pub(super) struct ShellExecuteInfo {
        size: u32,
        mask: u32,
        window: *mut c_void,
        verb: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
        instance: *mut c_void,
        id_list: *mut c_void,
        class: *const u16,
        class_key: *mut c_void,
        hot_key: u32,
        icon_or_monitor: *mut c_void,
        process: *mut c_void,
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
        fn SHParseDisplayName(
            name: *const u16,
            bind: *mut c_void,
            pidl: *mut *mut c_void,
            flags: u32,
            attributes: *mut u32,
        ) -> i32;
        fn SHOpenFolderAndSelectItems(
            pidl: *const c_void,
            count: u32,
            children: *const *const c_void,
            flags: u32,
        ) -> i32;
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(memory: *mut c_void);
    }
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }
    struct Pidl(*mut c_void);
    impl Drop for Pidl {
        fn drop(&mut self) {
            unsafe { CoTaskMemFree(self.0) }
        }
    }
    fn result(hr: i32, label: &str) -> Result<(), String> {
        if hr < 0 {
            Err(format!("{label}失败：HRESULT 0x{:08X}", hr as u32))
        } else {
            Ok(())
        }
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    pub fn perform(path: &str, directory: bool, action: Action) -> Result<(), String> {
        // SAFETY: new thread; no COM initialization precedes this call.
        result(
            unsafe { CoInitializeEx(null_mut(), 0x2 | 0x4) },
            "初始化 Windows 文件操作",
        )?;
        let _com = Com;
        let file = wide(path);
        if action == Action::Reveal && !directory {
            let mut raw = null_mut();
            // SAFETY: file is NUL-terminated UTF-16 and raw is a valid out pointer.
            let hr =
                unsafe { SHParseDisplayName(file.as_ptr(), null_mut(), &mut raw, 0, null_mut()) };
            let pidl = Pidl(raw);
            result(hr, "解析文件位置")?;
            if pidl.0.is_null() {
                return Err("无法解析文件位置".into());
            }
            // cidl=0 selects the fully specified item in its parent folder.
            return result(
                unsafe { SHOpenFolderAndSelectItems(pidl.0, 0, null(), 0) },
                "资源管理器定位",
            );
        }
        let verb = wide(if directory { "explore" } else { "open" });
        // SAFETY: repr(C) matches SHELLEXECUTEINFOW; all pointers remain live for this call.
        let mut info: ShellExecuteInfo = unsafe { std::mem::zeroed() };
        info.size = std::mem::size_of::<ShellExecuteInfo>() as u32;
        info.mask = 0x100 | 0x400; // NOASYNC + FLAG_NO_UI; keep normal Windows security checks.
        info.verb = verb.as_ptr();
        info.file = file.as_ptr();
        info.show = 1;
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            Err(format!(
                "Windows {}失败（请检查默认程序、文件是否存在及访问权限）：{}",
                if directory {
                    "打开文件夹"
                } else {
                    "打开文件"
                },
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model, project_io};
    use std::{cell::RefCell, fs, path::PathBuf};
    struct Fixture {
        _temp: tempfile::TempDir,
        store: ProjectStore,
        token: String,
        root: PathBuf,
        json: PathBuf,
        external: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let store = ProjectStore::default();
            let opened = project_io::create(&store, temp.path(), model::sample()).unwrap();
            let root = Path::new(&opened.path).parent().unwrap().to_path_buf();
            let mut p: serde_json::Value = serde_json::from_str(&opened.json).unwrap();
            p["nodes"] = serde_json::json!([{"id":"a","title":"A","parentId":null,"weight":0,"progress":73,"color":null,"linkedPaths":["../外部 文件夹"]}]);
        p["views"]["tree"]["positions"] = serde_json::json!({"a":{"x":0,"y":0}});
            project_io::save(&store, &opened.token, &p.to_string()).unwrap();
            internal_files::create(&store, &opened.token, "a", "", "内部 空格.txt").unwrap();
            let folder = root.join("Nodes/a/子 文件夹");
            fs::create_dir(&folder).unwrap();
            fs::write(folder.join("内部 深层.md"), "internal original").unwrap();
            let external = temp.path().join("外部 文件夹");
            fs::create_dir(&external).unwrap();
            fs::create_dir(external.join("子目录")).unwrap();
            fs::write(external.join("外部 空格.txt"), "external original").unwrap();
            Self {
                _temp: temp,
                store,
                token: opened.token,
                root,
                json: opened.path.into(),
                external,
            }
        }
        fn invoke(
            &self,
            target: &Target,
            action: Action,
        ) -> Result<(String, Vec<(String, bool, Action)>), String> {
            let calls = RefCell::new(vec![]);
            let path = dispatch(&self.store, &self.token, "a", target, action, |p, d, a| {
                calls
                    .borrow_mut()
                    .push((project_io::display_directory(p), d, a));
                Ok(())
            })?;
            Ok((path, calls.into_inner()))
        }
    }
    fn internal(p: &str) -> Target {
        Target::Internal { relative: p.into() }
    }
    fn external(p: &str) -> Target {
        Target::External {
            linked: "../外部 文件夹".into(),
            relative: p.into(),
        }
    }
    #[test]
    fn internal_external_open_dispatch_and_absolute_clipboard_paths() {
        let f = Fixture::new();
        for (target, expected) in [
            (
                internal("内部 空格.txt"),
                f.root.join("Nodes/a/内部 空格.txt"),
            ),
            (
                internal("子 文件夹/内部 深层.md"),
                f.root.join("Nodes/a/子 文件夹/内部 深层.md"),
            ),
            (
                external("外部 空格.txt"),
                fs::canonicalize(f.external.join("外部 空格.txt")).unwrap(),
            ),
        ] {
            let expected = project_io::display_directory(&expected);
            let (path, calls) = f.invoke(&target, Action::Path).unwrap();
            assert_eq!(path, expected);
            assert!(calls.is_empty());
            let (_, calls) = f.invoke(&target, Action::Open).unwrap();
            assert_eq!(calls, [(expected, false, Action::Open)]);
        }
        let mut p: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&f.json).unwrap()).unwrap();
        p["nodes"][0]["linkedPaths"] = serde_json::json!(["../外部 文件夹/外部 空格.txt"]);
        project_io::save(&f.store, &f.token, &p.to_string()).unwrap();
        let root_file = Target::External {
            linked: "../外部 文件夹/外部 空格.txt".into(),
            relative: String::new(),
        };
        assert!(!f.invoke(&root_file, Action::Open).unwrap().1[0].1);
    }
    #[test]
    fn reveal_selects_files_and_opens_folders_but_default_open_rejects_folders() {
        let f = Fixture::new();
        for target in [internal("子 文件夹"), external(""), external("子目录")] {
            let (_, calls) = f.invoke(&target, Action::Reveal).unwrap();
            assert!(calls[0].1);
            assert_eq!(calls[0].2, Action::Reveal);
            assert!(f.invoke(&target, Action::Open).is_err());
        }
        for target in [internal("内部 空格.txt"), external("外部 空格.txt")] {
            let (_, calls) = f.invoke(&target, Action::Reveal).unwrap();
            assert!(!calls[0].1);
        }
    }
    #[test]
    fn missing_targets_and_shell_failures_are_errors_and_never_modify_data() {
        let f = Fixture::new();
        let json = fs::read(&f.json).unwrap();
        for target in [internal("missing.txt"), external("missing.txt")] {
            assert!(f.invoke(&target, Action::Open).is_err());
        }
        let target = external("外部 空格.txt");
        let error = dispatch(&f.store, &f.token, "a", &target, Action::Open, |_, _, _| {
            Err("没有默认程序或拒绝访问".into())
        })
        .unwrap_err();
        assert!(error.contains("默认程序"));
        assert_eq!(fs::read(&f.json).unwrap(), json);
        assert_eq!(
            fs::read_to_string(f.external.join("外部 空格.txt")).unwrap(),
            "external original"
        );
        fs::remove_dir_all(&f.external).unwrap();
        assert!(f.invoke(&target, Action::Reveal).is_err());
    }
    #[test]
    fn rejects_unlinked_unauthorized_and_traversal_for_every_operation() {
        let f = Fixture::new();
        for action in [Action::Path, Action::Open, Action::Reveal] {
            for bad in [
                "",
                "../外部 文件夹/外部 空格.txt",
                "/Windows",
                "C:/Windows",
                "子 文件夹/../内部 空格.txt",
                "a:stream",
                "a\\b",
            ] {
                assert!(f.invoke(&internal(bad), action).is_err(), "{bad}");
            }
            for bad in ["../", "子目录/../外部 空格.txt", "C:/Windows", "a\\b"] {
                assert!(f.invoke(&external(bad), action).is_err());
            }
            let unlinked = Target::External {
                linked: "C:/Windows".into(),
                relative: String::new(),
            };
            assert!(f.invoke(&unlinked, action).is_err());
            assert!(dispatch(
                &f.store,
                "bad",
                "a",
                &external(""),
                action,
                |_, _, _| panic!("must not launch")
            )
            .is_err());
            assert!(dispatch(
                &f.store,
                &f.token,
                "other",
                &external(""),
                action,
                |_, _, _| panic!("must not launch")
            )
            .is_err());
        }
        assert!(serde_json::from_str::<Target>(
            r#"{"source":"internal","relative":"x","path":"C:/other"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Action>("\"execute\"").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn junctions_cannot_escape_internal_or_external_action_boundaries() {
        let f = Fixture::new();
        for junction in [f.root.join("Nodes/a/escape"), f.external.join("escape")] {
            let result = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&junction)
                .arg(f._temp.path())
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        for action in [Action::Path, Action::Open, Action::Reveal] {
            assert!(f.invoke(&internal("escape"), action).is_err());
            assert!(f.invoke(&external("escape"), action).is_err());
        }
        fs::remove_dir(f.root.join("Nodes/a/escape")).unwrap();
        fs::remove_dir(f.external.join("escape")).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn locked_file_is_reported_and_can_retry_after_unlock() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(f.external.join("外部 空格.txt"))
            .unwrap();
        assert!(f.invoke(&external("外部 空格.txt"), Action::Open).is_err());
        drop(lock);
        assert!(f.invoke(&external("外部 空格.txt"), Action::Open).is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn shell_struct_layout_is_windows_abi() {
        assert_eq!(std::mem::size_of::<super::windows::ShellExecuteInfo>(), 112);
    }
}

pub fn recycle(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let path = project_io::display_directory(path);
        if path.encode_utf16().count() >= 260 {
            return Err("回收站操作暂不支持超过259字符的路径；原文件保留".into());
        }
        #[repr(C)]
        struct Operation {
            window: *mut std::ffi::c_void,
            operation: u32,
            from: *const u16,
            to: *const u16,
            flags: u16,
            aborted: i32,
            mappings: *mut std::ffi::c_void,
            title: *const u16,
        }
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn SHFileOperationW(operation: *mut Operation) -> i32;
        }
        let name: Vec<u16> = path.encode_utf16().chain([0, 0]).collect();
        let mut op: Operation = unsafe { std::mem::zeroed() };
        op.operation = 3;
        op.from = name.as_ptr();
        op.flags = 0x40 | 0x1000 | 0x2000 | 0x4000; // ALLOWUNDO, NORECURSION, NO_CONNECTED_ELEMENTS, WANTNUKEWARNING.
        let code = unsafe { SHFileOperationW(&mut op) };
        if op.aborted != 0 {
            Err("已取消删除；原文件保留".into())
        } else if code != 0 {
            Err(format!("Windows 回收站操作失败 ({code})；请检查原文件"))
        } else {
            Ok(())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("删除到回收站目前仅支持 Windows".into())
    }
}
