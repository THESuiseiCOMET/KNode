mod app_settings;
mod desktop_integration;
mod startup;
mod external_files;
mod internal_files;
mod model;
mod project_io;
mod system_files;
mod window_state;

use project_io::{OpenedProject, ProjectStore};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn create_project(
    app: AppHandle,
    json: String,
    language: Option<String>,
) -> Result<Option<OpenedProject>, String> {
    model::parse(&json)?;
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title(if language.as_deref() == Some("en") {
                "Select parent folder for new project"
            } else {
                "选择新项目的父目录"
            })
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let parent = selected.into_path().map_err(|e| e.to_string())?;
        project_io::create(&app.state::<ProjectStore>(), &parent, json).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn open_project(
    app: AppHandle,
    language: Option<String>,
    path: Option<String>,
) -> Result<Option<OpenedProject>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = path {
            return project_io::open(&app.state::<ProjectStore>(), std::path::Path::new(&path))
                .map(Some);
        }
        let selected = app
            .dialog()
            .file()
            .set_title(if language.as_deref() == Some("en") {
                "Open KNode project JSON"
            } else {
                "打开 KNode 项目 JSON"
            })
            .add_filter("KNode JSON", &["json"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        project_io::open(&app.state::<ProjectStore>(), &path).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_project(app: AppHandle, token: String, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_io::save(&app.state::<ProjectStore>(), &token, &json)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn release_project(state: tauri::State<'_, ProjectStore>, token: String) -> Result<(), String> {
    state
        .inner()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&token);
    Ok(())
}
#[tauri::command]
async fn open_project_folder(app: AppHandle, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = project_io::directory(&app.state::<ProjectStore>(), &token)?;
        #[cfg(windows)]
        {
            let explorer =
                std::path::PathBuf::from(std::env::var_os("WINDIR").ok_or("缺少 Windows 目录")?)
                    .join("explorer.exe");
            std::process::Command::new(explorer)
                .arg(project_io::display_directory(&root))
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = root;
            Err("打开项目文件夹目前仅支持 Windows".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pick_linked_paths(
    app: AppHandle,
    token: String,
    node_id: String,
    directory: bool,
    replace: Option<String>,
) -> Result<Option<Vec<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Validate session/node before showing a native picker; never accept arbitrary write paths.
        external_files::statuses(&app.state::<ProjectStore>(), &token, &node_id)?;
        let picker = app
            .dialog()
            .file()
            .set_title("关联外部目标（仅保存路径，不复制原件）");
        let selected = if replace.is_some() {
            if directory {
                picker.blocking_pick_folder().map(|p| vec![p])
            } else {
                picker.blocking_pick_file().map(|p| vec![p])
            }
        } else if directory {
            picker.blocking_pick_folders()
        } else {
            picker.blocking_pick_files()
        };
        let Some(selected) = selected else {
            return Ok(None);
        };
        let paths = selected
            .into_iter()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        external_files::normalize(
            &app.state::<ProjectStore>(),
            &token,
            &node_id,
            &paths,
            replace.as_deref(),
        )
        .map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn linked_path_statuses(
    app: AppHandle,
    token: String,
    node_id: String,
) -> Result<Vec<external_files::Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        external_files::statuses(&app.state::<ProjectStore>(), &token, &node_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn list_linked_directory(
    app: AppHandle,
    token: String,
    node_id: String,
    linked: String,
    relative: String,
) -> Result<Vec<external_files::Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        external_files::list(
            &app.state::<ProjectStore>(),
            &token,
            &node_id,
            &linked,
            &relative,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn list_node_files(
    app: AppHandle,
    token: String,
    node_id: String,
    relative: String,
) -> Result<Vec<internal_files::Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        internal_files::list(&app.state::<ProjectStore>(), &token, &node_id, &relative)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn create_node_file(
    app: AppHandle,
    token: String,
    node_id: String,
    relative: String,
    name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        internal_files::create(
            &app.state::<ProjectStore>(),
            &token,
            &node_id,
            &relative,
            &name,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_node_file(
    app: AppHandle,
    token: String,
    node_id: String,
    relative: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        internal_files::read(&app.state::<ProjectStore>(), &token, &node_id, &relative)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn copy_node_files(
    app: AppHandle,
    token: String,
    pairs: Vec<(String, String)>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        internal_files::copy_nodes(&app.state::<ProjectStore>(), &token, &pairs)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn check_node_files(
    app: AppHandle,
    token: String,
    ids: Vec<String>,
    descendants: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        internal_files::check_nodes(&app.state::<ProjectStore>(), &token, &ids, descendants)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn import_node_file(
    app: AppHandle,
    token: String,
    node_id: String,
    relative: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = app
            .dialog()
            .file()
            .set_title("复制文件到节点（保留外部原件）")
            .blocking_pick_file();
        let Some(source) = source else {
            return Ok(false);
        };
        internal_files::import(
            &app.state::<ProjectStore>(),
            &token,
            &node_id,
            &relative,
            &source.into_path().map_err(|e| e.to_string())?,
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn file_action(
    app: AppHandle,
    token: String,
    node_id: String,
    target: system_files::Target,
    action: system_files::Action,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_files::run(
            &app.state::<ProjectStore>(),
            &token,
            &node_id,
            &target,
            action,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn file_double_click_ms() -> u32 {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetDoubleClickTime() -> u32;
        }
        unsafe { GetDoubleClickTime() }
    }
    #[cfg(not(windows))]
    {
        500
    }
}

#[tauri::command]
async fn import_node_folder(
    app: AppHandle,
    token: String,
    node_id: String,
    relative: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = app
            .dialog()
            .file()
            .set_title("复制导入文件夹（保留原件）")
            .blocking_pick_folder();
        let Some(source) = source else {
            return Ok(false);
        };
        internal_files::import_folder(
            &app.state::<ProjectStore>(),
            &token,
            &node_id,
            &relative,
            &source.into_path().map_err(|e| e.to_string())?,
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn rename_node_file(
    app: AppHandle,
    token: String,
    node_id: String,
    relative: String,
    name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        internal_files::rename_file(
            &app.state::<ProjectStore>(),
            &token,
            &node_id,
            &relative,
            &name,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn delete_node_file(
    app: AppHandle,
    token: String,
    node_id: String,
    relative: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        internal_files::delete_file(&app.state::<ProjectStore>(), &token, &node_id, &relative)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn create_linked_file(
    app: AppHandle,
    token: String,
    node_id: String,
    extension: String,
) -> Result<Option<Vec<String>>, String> {
    if !matches!(extension.as_str(), "txt" | "md") {
        return Err("不支持的文件类型".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        external_files::statuses(&app.state::<ProjectStore>(), &token, &node_id)?;
        let selected = app
            .dialog()
            .file()
            .set_title("新建外部文件并关联（不覆盖已有文件）")
            .set_file_name(format!("新建文件.{extension}"))
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        external_files::create_selected(
            &app.state::<ProjectStore>(),
            &token,
            &node_id,
            &selected.into_path().map_err(|e| e.to_string())?,
            &extension,
        )
        .map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn rename_project(
    app: AppHandle,
    token: String,
    name: String,
) -> Result<OpenedProject, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_io::rename(&app.state::<ProjectStore>(), &token, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn updates_configured(app: tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ProjectStore::default())
        .manage(window_state::WindowMemory::default())
        .setup(|app| {
            desktop_integration::initialize(app)?;
            if let Some(window) = app.get_webview_window("main") {
                window_state::initialize(app.handle(), &window)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
            ) {
                window_state::remember(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            updates_configured,
            startup::get_startup,
            startup::set_startup,
            desktop_integration::set_tray_language,
            file_double_click_ms,
            import_node_folder,
            rename_node_file,
            delete_node_file,
            create_linked_file,
            file_action,
            pick_linked_paths,
            linked_path_statuses,
            list_linked_directory,
            list_node_files,
            create_node_file,
            read_node_file,
            check_node_files,
            copy_node_files,
            import_node_file,
            rename_project,
            app_settings::load_ai_config,
            app_settings::save_ai_config,
            app_settings::test_ai_connection,
            create_project,
            open_project,
            save_project,
            release_project,
            open_project_folder,
            window_state::save_window_state
        ])
        .run(tauri::generate_context!())
        .expect("Forest Editor 启动失败");
}
