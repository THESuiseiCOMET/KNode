use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct StartupStatus {
    enabled: bool,
    supported: bool,
}

fn command(executable: &Path) -> Result<String, String> {
    if !executable.is_absolute() || !executable.is_file() {
        return Err("启动程序路径无效".into());
    }
    let path = executable.to_str().ok_or("启动路径编码无效")?;
    if path.contains('"') || path.chars().any(char::is_control) {
        return Err("启动路径包含非法字符".into());
    }
    let value = format!("\"{path}\"");
    if value.encode_utf16().count() > 260 {
        return Err("启动路径过长，请将程序放在较短的目录中".into());
    }
    Ok(value)
}

#[cfg(windows)]
mod registry {
    use std::{ffi::c_void, ptr};
    type HKey = *mut c_void;
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(
            root: HKey,
            subkey: *const u16,
            options: u32,
            access: u32,
            key: *mut HKey,
        ) -> i32;
        fn RegCreateKeyExW(
            root: HKey,
            subkey: *const u16,
            reserved: u32,
            class: *mut u16,
            options: u32,
            access: u32,
            security: *const c_void,
            key: *mut HKey,
            disposition: *mut u32,
        ) -> i32;
        fn RegQueryValueExW(
            key: HKey,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            bytes: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            key: HKey,
            name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            bytes: u32,
        ) -> i32;
        fn RegDeleteValueW(key: HKey, name: *const u16) -> i32;
        fn RegCloseKey(key: HKey) -> i32;
        #[cfg(test)]
        fn RegDeleteKeyW(root: HKey, subkey: *const u16) -> i32;
    }
    fn current_user() -> HKey {
        0x80000001_u32 as i32 as isize as HKey
    }
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    fn failure(action: &str, code: i32) -> String {
        format!(
            "{action}失败（Windows {code}）：{}",
            std::io::Error::from_raw_os_error(code)
        )
    }
    struct Key(HKey);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn open(subkey: &str, write: bool) -> Result<Option<Key>, String> {
        let subkey = wide(subkey);
        let mut handle = ptr::null_mut();
        let status = if write {
            unsafe {
                RegCreateKeyExW(
                    current_user(),
                    subkey.as_ptr(),
                    0,
                    ptr::null_mut(),
                    0,
                    3,
                    ptr::null(),
                    &mut handle,
                    ptr::null_mut(),
                )
            }
        } else {
            unsafe { RegOpenKeyExW(current_user(), subkey.as_ptr(), 0, 1, &mut handle) }
        };
        match status {
            0 => Ok(Some(Key(handle))),
            2 | 3 if !write => Ok(None),
            _ => Err(failure("访问启动设置", status)),
        }
    }
    pub fn read(subkey: &str, name: &str) -> Result<Option<String>, String> {
        let Some(key) = open(subkey, false)? else {
            return Ok(None);
        };
        let name = wide(name);
        let (mut kind, mut bytes) = (0, 0);
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                ptr::null_mut(),
                &mut kind,
                ptr::null_mut(),
                &mut bytes,
            )
        };
        if status == 2 {
            return Ok(None);
        }
        if status != 0 {
            return Err(failure("读取启动设置", status));
        }
        if kind != 1 || bytes == 0 || bytes > 65536 || bytes % 2 != 0 {
            return Err("启动项格式无效".into());
        }
        let mut buffer = vec![0u16; (bytes / 2) as usize];
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                ptr::null_mut(),
                &mut kind,
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if status != 0 {
            return Err(failure("读取启动设置", status));
        }
        if kind != 1 || bytes % 2 != 0 || bytes as usize > buffer.len() * 2 {
            return Err("启动项格式无效".into());
        }
        buffer.truncate((bytes / 2) as usize);
        while buffer.last() == Some(&0) {
            buffer.pop();
        }
        if buffer.contains(&0) {
            return Err("启动项包含非法空字符".into());
        }
        String::from_utf16(&buffer)
            .map(Some)
            .map_err(|_| "启动项编码无效".into())
    }
    pub fn write(subkey: &str, name: &str, value: Option<&str>) -> Result<(), String> {
        // Disabling must not create a missing Run key.
        let key = if value.is_some() {
            open(subkey, true)?
        } else {
            let path = wide(subkey);
            let mut handle = ptr::null_mut();
            let status = unsafe { RegOpenKeyExW(current_user(), path.as_ptr(), 0, 3, &mut handle) };
            match status {
                0 => Some(Key(handle)),
                2 | 3 => None,
                _ => return Err(failure("访问启动设置", status)),
            }
        };
        let Some(key) = key else { return Ok(()) };
        let name = wide(name);
        let status = if let Some(value) = value {
            let data = wide(value);
            unsafe {
                RegSetValueExW(
                    key.0,
                    name.as_ptr(),
                    0,
                    1,
                    data.as_ptr().cast(),
                    (data.len() * 2) as u32,
                )
            }
        } else {
            unsafe { RegDeleteValueW(key.0, name.as_ptr()) }
        };
        if status == 0 || (value.is_none() && status == 2) {
            Ok(())
        } else {
            Err(failure("修改启动设置", status))
        }
    }
    #[cfg(test)]
    pub fn remove_test_key(subkey: &str) {
        assert!(subkey.starts_with("Software\\KNode\\Tests\\"));
        assert_eq!(
            unsafe { RegDeleteKeyW(current_user(), wide(subkey).as_ptr()) },
            0
        );
    }
}

#[cfg(windows)]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
fn status() -> Result<StartupStatus, String> {
    let saved = registry::read(RUN_KEY, "KNode")?;
    let enabled = if let Some(saved) = saved {
        let expected = command(&std::env::current_exe().map_err(|e| e.to_string())?)?;
        saved.to_lowercase() == expected.to_lowercase()
    } else {
        false
    };
    Ok(StartupStatus {
        enabled,
        supported: true,
    })
}
#[cfg(not(windows))]
fn status() -> Result<StartupStatus, String> {
    Ok(StartupStatus {
        enabled: false,
        supported: false,
    })
}

#[tauri::command]
pub async fn get_startup() -> Result<StartupStatus, String> {
    tauri::async_runtime::spawn_blocking(status)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn set_startup(enabled: bool) -> Result<StartupStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            let value = if enabled {
                Some(command(
                    &std::env::current_exe().map_err(|e| e.to_string())?,
                )?)
            } else {
                None
            };
            registry::write(RUN_KEY, "KNode", value.as_deref())?;
            status()
        }
        #[cfg(not(windows))]
        {
            let _ = enabled;
            Err("当前系统不支持开机启动设置".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_unicode_and_spaces_and_rejects_invalid_paths() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("中文 空格 KNode.exe");
        std::fs::write(&exe, b"test fixture, never executed").unwrap();
        assert_eq!(command(&exe).unwrap(), format!("\"{}\"", exe.display()));
        assert!(command(Path::new("KNode.exe")).is_err());
        assert!(command(&dir.path().join("missing.exe")).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn registry_roundtrip_in_isolated_test_key_preserves_other_values() {
        let key = format!("Software\\KNode\\Tests\\{}", uuid::Uuid::new_v4());
        assert!(registry::read(&key, "KNode").unwrap().is_none());
        let value = "\"C:\\中文 空格\\KNode.exe\"";
        registry::write(&key, "other", Some("untouched")).unwrap();
        registry::write(&key, "KNode", Some(value)).unwrap();
        assert_eq!(
            registry::read(&key, "KNode").unwrap().as_deref(),
            Some(value)
        );
        registry::write(&key, "KNode", None).unwrap();
        registry::write(&key, "KNode", None).unwrap();
        assert_eq!(registry::read(&key, "KNode").unwrap(), None);
        assert_eq!(
            registry::read(&key, "other").unwrap().as_deref(),
            Some("untouched")
        );
        registry::write(&key, "other", None).unwrap();
        registry::remove_test_key(&key);
    }
}
