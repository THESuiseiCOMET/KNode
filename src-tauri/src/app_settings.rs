use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub config: AiConfig,
    pub has_key: bool,
}
fn target(config: &AiConfig) -> String {
    format!(
        "KNode/AI-service/{}",
        config.base_url.trim().trim_end_matches('/')
    )
}

#[cfg(windows)]
mod credentials {
    use std::{ffi::c_void, ptr};
    #[repr(C)]
    struct Credential {
        flags: u32,
        kind: u32,
        target: *mut u16,
        comment: *mut u16,
        written: [u32; 2],
        size: u32,
        blob: *mut u8,
        persist: u32,
        attributes: u32,
        attribute: *mut c_void,
        alias: *mut u16,
        user: *mut u16,
    }
    #[link(name = "Advapi32")]
    unsafe extern "system" {
        fn CredWriteW(c: *const Credential, flags: u32) -> i32;
        fn CredReadW(target: *const u16, kind: u32, flags: u32, out: *mut *mut Credential) -> i32;
        fn CredFree(p: *mut c_void);
        fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    pub fn delete(target: &str) -> Result<(), String> {
        let name = wide(target);
        if unsafe { CredDeleteW(name.as_ptr(), 1, 0) } == 0
            && std::io::Error::last_os_error().raw_os_error() != Some(1168)
        {
            return Err("无法删除Windows凭据".into());
        }
        Ok(())
    }
    pub fn set(target: &str, key: &str) -> Result<(), String> {
        if key.is_empty() || key.len() > 2048 || key.chars().any(|c| c.is_control()) {
            return Err("API Key格式无效".into());
        }
        let mut name = wide(target);
        let mut bytes = key.as_bytes().to_vec();
        let c = Credential {
            flags: 0,
            kind: 1,
            target: name.as_mut_ptr(),
            comment: ptr::null_mut(),
            written: [0; 2],
            size: bytes.len() as u32,
            blob: bytes.as_mut_ptr(),
            persist: 2,
            attributes: 0,
            attribute: ptr::null_mut(),
            alias: ptr::null_mut(),
            user: ptr::null_mut(),
        };
        let result = unsafe { CredWriteW(&c, 0) };
        bytes.fill(0);
        if result == 0 {
            Err("无法写入Windows凭据管理器".into())
        } else {
            Ok(())
        }
    }
    pub fn get(target: &str) -> Result<Option<String>, String> {
        let name = wide(target);
        let mut p = ptr::null_mut();
        if unsafe { CredReadW(name.as_ptr(), 1, 0, &mut p) } == 0 {
            let e = std::io::Error::last_os_error();
            return if e.raw_os_error() == Some(1168) {
                Ok(None)
            } else {
                Err("无法读取Windows凭据管理器".into())
            };
        };
        let result = unsafe {
            String::from_utf8(std::slice::from_raw_parts((*p).blob, (*p).size as usize).to_vec())
                .map_err(|_| "凭据编码无效".to_string())
        };
        unsafe { CredFree(p.cast()) };
        result.map(Some)
    }
}
#[cfg(not(windows))]
mod credentials {
    pub fn delete(_: &str) -> Result<(), String> {
        Ok(())
    }
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err("当前系统尚无安全凭据实现".into())
    }
    pub fn get(_: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
}
fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("ai-service.json"))
}
fn validate(config: &AiConfig) -> Result<reqwest::Url, String> {
    if !matches!(config.provider.as_str(), "OpenAI-compatible" | "Local")
        || config.model.trim().is_empty()
        || config.model.len() > 200
    {
        return Err("请填写服务类型及模型名称".into());
    }
    let url = reqwest::Url::parse(config.base_url.trim()).map_err(|_| "API Base URL无效")?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("远程AI服务必须使用HTTPS；仅本机允许HTTP".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Base URL不能包含凭据、查询或片段".into());
    }
    Ok(url)
}
fn write_config(path: &Path, config: &AiConfig) -> Result<(), String> {
    let dir = path.parent().ok_or("配置路径无效")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    tmp.write_all(&serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|_| "配置保存失败，旧配置保留")?;
    Ok(())
}
#[tauri::command]
pub fn load_ai_config(app: AppHandle) -> Result<AiStatus, String> {
    let p = path(&app)?;
    let config = if p.exists() {
        let meta = fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
        if meta.len() > 64 * 1024 {
            return Err("AI配置文件过大".into());
        }
        serde_json::from_slice(&fs::read(p).map_err(|e| e.to_string())?)
            .map_err(|_| "AI配置损坏")?
    } else {
        AiConfig {
            provider: "OpenAI-compatible".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: String::new(),
        }
    };
    let has_key = credentials::get(&target(&config))?.is_some();
    Ok(AiStatus { config, has_key })
}
#[tauri::command]
pub fn save_ai_config(
    app: AppHandle,
    config: AiConfig,
    api_key: Option<String>,
) -> Result<(), String> {
    validate(&config)?;
    let target = target(&config);
    let old = credentials::get(&target)?;
    let next = api_key.filter(|k| !k.is_empty());
    if let Some(key) = &next {
        credentials::set(&target, key)?;
    }
    if let Err(e) = write_config(&path(&app)?, &config) {
        if next.is_some() {
            if let Some(old) = old {
                credentials::set(&target, &old)?
            } else {
                credentials::delete(&target)?
            }
        }
        return Err(e);
    }
    Ok(())
}
#[tauri::command]
pub async fn test_ai_connection(
    config: AiConfig,
    api_key: Option<String>,
) -> Result<String, String> {
    let mut url = validate(&config)?;
    url.set_path(&format!("{}/models", url.path().trim_end_matches('/')));
    let key = match api_key.filter(|k| !k.is_empty()) {
        Some(k) => Some(k),
        None => credentials::get(&target(&config))?,
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "无法创建HTTP客户端")?;
    let mut request = client.get(url);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "连接失败，请检查服务地址、网络或TLS证书")?;
    if !response.status().is_success() {
        return Err(format!("AI服务返回HTTP {}", response.status().as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取服务响应失败")? {
        if body.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("服务响应过大".into());
        }
        body.extend_from_slice(&chunk)
    }
    let data: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "服务未返回有效JSON")?;
    let found = data
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("服务响应不含模型清单")?
        .iter()
        .any(|v| v.get("id").and_then(|id| id.as_str()) == Some(config.model.as_str()));
    if !found {
        return Err("连接成功，但服务模型清单中没有所选模型".into());
    }
    Ok("连接成功，模型可用".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_insecure_and_secret_urls() {
        for url in [
            "http://example.com/v1",
            "https://user:secret@example.com/v1",
            "file:///test",
            "https://example.com/?key=x",
        ] {
            assert!(validate(&AiConfig {
                provider: "OpenAI-compatible".into(),
                base_url: url.into(),
                model: "model".into()
            })
            .is_err())
        }
    }
    #[test]
    fn config_file_never_contains_key() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        write_config(
            &p,
            &AiConfig {
                provider: "Local".into(),
                base_url: "http://localhost:1234/v1".into(),
                model: "test".into(),
            },
        )
        .unwrap();
        let s = fs::read_to_string(p).unwrap();
        assert!(!s.contains("apiKey"));
        assert!(!s.contains("api_key"));
    }
}

#[cfg(all(test, windows))]
mod credential_tests {
    use super::*;
    #[test]
    fn windows_credentials_roundtrip_without_plaintext_config() {
        let target = format!("KNode/test/{}", uuid::Uuid::new_v4());
        assert!(credentials::get(&target).unwrap().is_none());
        credentials::set(&target, "test-only-not-a-real-key").unwrap();
        assert_eq!(
            credentials::get(&target).unwrap().as_deref(),
            Some("test-only-not-a-real-key")
        );
        credentials::delete(&target).unwrap();
        assert!(credentials::get(&target).unwrap().is_none());
    }
}

#[cfg(test)]
mod connection_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn server(status: &str, body: &str) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://127.0.0.1:1/no-follow\r\n\r\n{body}",body.len());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut b = [0; 1024];
                let n = stream.read(&mut b).unwrap();
                request.extend_from_slice(&b[..n]);
                if n == 0 || request.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
            }
            let text = String::from_utf8(request).unwrap().to_lowercase();
            assert!(text.starts_with("get /v1/models "));
            assert!(text.contains("authorization: bearer fake-test-token"));
            stream.write_all(response.as_bytes()).unwrap();
        });
        (format!("http://{address}/v1"), thread)
    }
    #[test]
    fn real_http_test_validates_model_and_rejects_redirects() {
        for (status, body, success) in [
            ("200 OK", r#"{"data":[{"id":"test-model"}]}"#, true),
            ("200 OK", r#"{"data":[{"id":"other"}]}"#, false),
            ("302 Found", "{}", false),
        ] {
            let (url, thread) = server(status, body);
            let result = tauri::async_runtime::block_on(test_ai_connection(
                AiConfig {
                    provider: "Local".into(),
                    base_url: url,
                    model: "test-model".into(),
                },
                Some("fake-test-token".into()),
            ));
            assert_eq!(result.is_ok(), success);
            if status.starts_with("302") {
                assert!(result.unwrap_err().contains("302"))
            }
            thread.join().unwrap();
        }
    }
}
