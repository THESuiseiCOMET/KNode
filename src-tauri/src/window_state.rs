use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
    monitor_x: i32,
    monitor_y: i32,
    maximized: bool,
}
#[derive(Clone, Debug)]
pub struct Screen {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}
#[derive(Default)]
pub struct WindowMemory(pub Mutex<Option<Placement>>);
fn valid(p: &Placement) -> bool {
    p.scale.is_finite()
        && (0.5..=8.0).contains(&p.scale)
        && p.width > 0
        && p.height > 0
        && p.width <= 100_000
        && p.height <= 100_000
}
fn intersection(p: &Placement, m: &Screen) -> i64 {
    let w = (i64::from(p.x) + i64::from(p.width)).min(i64::from(m.x) + i64::from(m.width))
        - i64::from(p.x.max(m.x));
    let h = (i64::from(p.y) + i64::from(p.height)).min(i64::from(m.y) + i64::from(m.height))
        - i64::from(p.y.max(m.y));
    w.max(0) * h.max(0)
}
/// All stored/output rectangles are physical pixels. Scale only within the chosen
/// monitor's coordinate system; never multiply a global virtual-desktop origin.
fn restore(saved: Option<&Placement>, monitors: &[Screen]) -> Option<Placement> {
    let primary = monitors.first()?;
    let saved = saved.filter(|p| valid(p));
    let chosen = saved
        .and_then(|p| monitors.iter().max_by_key(|m| intersection(p, m)))
        .filter(|m| saved.is_some_and(|p| intersection(p, m) > 0))
        .unwrap_or(primary);
    let scale = chosen.scale;
    let width = saved.map_or(1200.0, |p| f64::from(p.width) / p.scale) * scale;
    let height = saved.map_or(800.0, |p| f64::from(p.height) / p.scale) * scale;
    let width = (width.max(720.0 * scale) as u32).min(chosen.width);
    let height = (height.max(500.0 * scale) as u32).min(chosen.height);
    let same_monitor = saved.is_some_and(|p| {
        p.monitor_x == chosen.x && p.monitor_y == chosen.y && intersection(p, chosen) > 0
    });
    let (x, y) = if let Some(p) = saved.filter(|_| same_monitor) {
        (
            chosen.x.saturating_add(
                ((f64::from(p.x) - f64::from(p.monitor_x)) / p.scale * scale) as i32,
            ),
            chosen.y.saturating_add(
                ((f64::from(p.y) - f64::from(p.monitor_y)) / p.scale * scale) as i32,
            ),
        )
    } else {
        (
            chosen.x.saturating_add(((chosen.width - width) / 2) as i32),
            chosen
                .y
                .saturating_add(((chosen.height - height) / 2) as i32),
        )
    };
    Some(Placement {
        x: x.clamp(
            chosen.x,
            chosen.x.saturating_add((chosen.width - width) as i32),
        ),
        y: y.clamp(
            chosen.y,
            chosen.y.saturating_add((chosen.height - height) as i32),
        ),
        width,
        height,
        scale,
        monitor_x: chosen.x,
        monitor_y: chosen.y,
        maximized: saved.is_some_and(|p| p.maximized),
    })
}
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("window-state.json"))
}
pub fn initialize(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let saved = config_path(app).ok().and_then(|path| {
        let meta = fs::metadata(&path).ok()?;
        if meta.len() > 8192 {
            return None;
        }
        serde_json::from_slice::<Placement>(&fs::read(path).ok()?).ok()
    });
    let primary = window.primary_monitor()?;
    let mut monitors = window.available_monitors()?;
    if let Some(p) = primary {
        monitors.sort_by_key(|m| m.position() != p.position());
    }
    let screens: Vec<_> = monitors
        .iter()
        .map(|m| {
            let area = m.work_area();
            Screen {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
                scale: m.scale_factor(),
            }
        })
        .collect();
    if let Some(p) = restore(saved.as_ref(), &screens) {
        window.set_size(PhysicalSize::new(p.width, p.height))?;
        window.set_position(PhysicalPosition::new(p.x, p.y))?;
        *app.state::<WindowMemory>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(p.clone());
        if p.maximized {
            window.maximize()?;
        }
    } else {
        window.center()?;
    }
    window.show()?;
    Ok(())
}
pub fn remember(window: &tauri::Window) {
    // Ignore minimized bounds and retain last normal rectangle when maximizing.
    if window.is_minimized().unwrap_or(true) {
        return;
    }
    if window.is_maximized().unwrap_or(true) {
        if let Some(p) = window
            .state::<WindowMemory>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            p.maximized = true;
        }
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let p = Placement {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        scale: monitor.scale_factor(),
        monitor_x: monitor.work_area().position.x,
        monitor_y: monitor.work_area().position.y,
        maximized: false,
    };
    if valid(&p) {
        *window
            .state::<WindowMemory>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(p);
    }
}
#[tauri::command]
pub fn save_window_state(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let mut placement = app
        .state::<WindowMemory>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("窗口状态尚未初始化")?;
    if !window.is_minimized().map_err(|e| e.to_string())? {
        placement.maximized = window.is_maximized().map_err(|e| e.to_string())?;
    }
    let path = config_path(&app)?;
    let root = path.parent().ok_or("窗口配置目录无效")?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec(&placement).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn screen(x: i32, scale: f64) -> Screen {
        Screen {
            x,
            y: 0,
            width: 1920,
            height: 1040,
            scale,
        }
    }
    fn saved() -> Placement {
        Placement {
            x: 200,
            y: 100,
            width: 1000,
            height: 700,
            scale: 1.0,
            monitor_x: 0,
            monitor_y: 0,
            maximized: false,
        }
    }
    #[test]
    fn normal_and_maximized_keep_normal_bounds() {
        let mut p = saved();
        p.maximized = true;
        let r = restore(Some(&p), &[screen(0, 1.0)]).unwrap();
        assert_eq!(
            (r.x, r.y, r.width, r.height, r.maximized),
            (200, 100, 1000, 700, true)
        );
    }
    #[test]
    fn removed_monitor_returns_to_existing_work_area() {
        let mut p = saved();
        p.x = 2400;
        p.monitor_x = 1920;
        let r = restore(Some(&p), &[screen(0, 1.0)]).unwrap();
        assert!(r.x >= 0 && r.x + r.width as i32 <= 1920 && r.y + r.height as i32 <= 1040);
    }
    #[test]
    fn dpi_change_scales_local_offsets_and_clamps_resolution() {
        let p = saved();
        let r = restore(Some(&p), &[screen(0, 1.5)]).unwrap();
        assert_eq!((r.x, r.y, r.width, r.height), (300, 0, 1500, 1040));
        let mut left = saved();
        left.x = -1700;
        left.monitor_x = -1920;
        let r = restore(Some(&left), &[screen(0, 1.0), screen(-1920, 1.25)]).unwrap();
        assert_eq!((r.x, r.width), (-1645, 1250));
    }
    #[test]
    fn corrupt_extreme_or_missing_state_uses_safe_defaults() {
        assert!(serde_json::from_str::<Placement>("{bad").is_err());
        let mut p = saved();
        p.scale = f64::NAN;
        let r = restore(Some(&p), &[screen(0, 1.0)]).unwrap();
        assert_eq!((r.width, r.height), (1200, 800));
        p.scale = 1.0;
        p.width = u32::MAX;
        assert_eq!(restore(Some(&p), &[screen(0, 1.0)]).unwrap().width, 1200);
        assert!(restore(None, &[]).is_none());
    }
}
