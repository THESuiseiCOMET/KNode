use tauri::AppHandle;

#[cfg(windows)]
mod windows {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
        AppHandle, Manager, Wry,
    };
    const CHINESE_LABELS: [&str; 3] = ["显示", "隐藏", "退出"];

    pub struct TrayMenu {
        show: MenuItem<Wry>,
        hide: MenuItem<Wry>,
        quit: MenuItem<Wry>,
        _icon: TrayIcon<Wry>,
    }
    fn show(app: &AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
    pub fn initialize(app: &tauri::App) -> tauri::Result<()> {
        let [show_label, hide_label, quit_label] = CHINESE_LABELS;
        let show_item = MenuItem::with_id(app, "tray-show", show_label, true, None::<&str>)?;
        let hide_item = MenuItem::with_id(app, "tray-hide", hide_label, true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, "tray-quit", quit_label, true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;
        let mut builder = TrayIconBuilder::with_id("knode-tray")
            .tooltip("KNode")
            .menu(&menu)
            .show_menu_on_left_click(false);
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        let icon = builder
            .on_menu_event(|app, event| match event.id.as_ref() {
                "tray-show" => show(app),
                "tray-hide" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
                "tray-quit" => {
                    show(app);
                    // close() invokes the frontend close guard; never app.exit/destroy here.
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.close();
                    }
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    }
                ) {
                    show(tray.app_handle());
                }
            })
            .build(app)?;
        app.manage(TrayMenu {
            show: show_item,
            hide: hide_item,
            quit: quit_item,
            _icon: icon,
        });
        Ok(())
    }
    pub fn language(app: &AppHandle, language: &str) -> Result<(), String> {
        let menu = app.state::<TrayMenu>();
        let [show_label, hide_label, quit_label] = if language == "en" {
            ["Show", "Hide", "Quit"]
        } else {
            CHINESE_LABELS
        };
        menu.show.set_text(show_label).map_err(|e| e.to_string())?;
        menu.hide.set_text(hide_label).map_err(|e| e.to_string())?;
        menu.quit.set_text(quit_label).map_err(|e| e.to_string())?;
        Ok(())
    }
}
pub fn initialize(app: &tauri::App) -> tauri::Result<()> {
    #[cfg(windows)]
    {
        windows::initialize(app)?;
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
    Ok(())
}
#[tauri::command]
pub fn set_tray_language(app: AppHandle, language: String) -> Result<(), String> {
    if !matches!(language.as_str(), "en" | "zh-CN") {
        return Err("不支持的语言".into());
    }
    #[cfg(windows)]
    {
        windows::language(&app, &language)?;
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
    Ok(())
}
