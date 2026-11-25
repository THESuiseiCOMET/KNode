use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub format: String,
    pub version: u32,
    pub project_id: String,
    pub name: String,
    pub views: Views,
    pub nodes: Vec<Node>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub title: String,
    // Option fields must be present as null or a string; serde alone accepts missing Option.
    #[serde(deserialize_with = "required_option")]
    pub parent_id: Option<String>,
    pub progress: f64,
    pub weight: f64,
    #[serde(deserialize_with = "required_option")]
    pub color: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_links"
    )]
    pub linked_paths: Option<Vec<String>>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Views {
    pub tree: TreeView,
    pub graph: GraphView,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeView {
    pub positions: HashMap<String, Point>,
    pub collapsed_ids: Vec<String>,
    pub viewport: Viewport,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphView {
    pub positions: HashMap<String, Point>,
    pub edges: Vec<GraphEdge>,
    pub viewport: Viewport,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub direction: Direction,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_label")]
    pub label: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction { Forward, Both, Undirected }
fn present_label<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
fn present_links<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<String>>, D::Error> {
    Vec::<String>::deserialize(d).map(Some)
}
pub fn valid_linked_path(s: &str) -> bool {
    if s.is_empty()
        || s.encode_utf16().count() > 4096
        || s.chars().any(|c| c.is_control() || "<>\"|?*".contains(c))
    {
        return false;
    }
    let path = s.replace('\\', "/");
    if path.starts_with('/') && !path.starts_with("//") {
        return false;
    }
    let drive = matches!(path.as_bytes(), [letter, b':', b'/', ..] if letter.is_ascii_alphabetic());
    if path.contains(':') && (!drive || path[2..].contains(':')) {
        return false;
    }
    let rest = if drive {
        &path[3..]
    } else {
        path.strip_prefix("//").unwrap_or(&path)
    };
    if path.starts_with("//") && rest.split('/').filter(|s| !s.is_empty()).count() < 2 {
        return false;
    }
    rest.is_empty()
        || rest
            .split('/')
            .all(|p| p == "." || p == ".." || valid_filename(p))
}
fn linked_key(s: &str) -> String {
    let path = s.replace('\\', "/").to_lowercase();
    let prefix = if path.starts_with("//") { "//" } else { "" };
    let mut parts: Vec<&str> = vec![];
    for p in path.split('/') {
        if p.is_empty() || p == "." {
            continue;
        }
        if p == ".."
            && parts
                .last()
                .is_some_and(|last| *last != ".." && !last.ends_with(':'))
        {
            parts.pop();
        } else {
            parts.push(p);
        }
    }
    format!("{prefix}{}", parts.join("/"))
}
fn required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

pub fn valid_title(s: &str) -> bool {
    !s.trim().is_empty() && s.encode_utf16().count() <= 200 && !s.chars().any(char::is_control)
}
pub fn valid_filename(s: &str) -> bool {
    if s.is_empty()
        || s.encode_utf16().count() > 240
        || s.ends_with(['.', ' '])
        || s == "."
        || s == ".."
        || s.chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return false;
    }
    let stem = s.split('.').next().unwrap_or("").to_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.starts_with("COM") || stem.starts_with("LPT"))
            .then(|| stem.chars().skip(3).collect::<String>())
            .map(|tail| {
                matches!(
                    tail.as_str(),
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
            .unwrap_or(false)
}
pub fn valid_node_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        && valid_filename(id)
}
fn coordinate(n: f64) -> bool {
    n.is_finite() && n.abs() <= 1e9
}
pub fn parse(json: &str) -> Result<Project, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("项目 JSON 格式无效：{e}"))?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(3) {
        return Err("不支持的项目版本：仅支持 V3，未迁移或覆盖原文件".into());
    }
    let p: Project = serde_json::from_value(value).map_err(|e| format!("项目 JSON 格式无效：{e}"))?;
    validate(&p)?;
    Ok(p)
}
pub fn validate(p: &Project) -> Result<(), String> {
    let fail = |s: &str| Err(s.to_string());
    if p.format != "forest-project" || p.version != 3 {
        return fail("格式签名或版本不支持，拒绝编辑");
    }
    if Uuid::parse_str(&p.project_id).is_err() || p.project_id.len() != 36 || !valid_title(&p.name)
    {
        return fail("项目 UUID 或名称无效");
    }
    for viewport in [&p.views.tree.viewport, &p.views.graph.viewport] {
        if !coordinate(viewport.x) || !coordinate(viewport.y) || !viewport.zoom.is_finite() || !(0.2..=2.5).contains(&viewport.zoom) {
            return fail("视口无效");
        }
    }
    let mut ids = HashSet::new();
    let mut directory_ids = HashSet::new();
    for n in &p.nodes {
        if let Some(links) = &n.linked_paths {
            let mut seen = HashSet::new();
            if links.is_empty()
                || links
                    .iter()
                    .any(|path| !valid_linked_path(path) || !seen.insert(linked_key(path)))
            {
                return fail("外部关联路径无效或重复；无关联时省略 linkedPaths");
            }
        }
        if !valid_node_id(&n.id)
            || !directory_ids.insert(n.id.to_ascii_lowercase())
            || !ids.insert(n.id.as_str())
        {
            return fail("节点 ID 不安全或重复（忽略大小写）");
        }
        if !valid_title(&n.title) {
            return fail("节点标题或坐标无效");
        }
        if !n.progress.is_finite() || !(0.0..=100.0).contains(&n.progress) {
            return fail("进度超出 0–100");
        }
        if !n.weight.is_finite()
            || n.weight < 0.0
            || n.weight > 9_007_199_254_740_991.0
            || n.weight.fract() != 0.0
        {
            return fail("权重不是非负安全整数");
        }
        if let Some(c) = &n.color {
            if c.len() != 7
                || !c.starts_with('#')
                || !c.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            {
                return fail("节点颜色无效");
            }
        }
    }
    for positions in [&p.views.tree.positions, &p.views.graph.positions] {
        for (id, point) in positions {
            if !ids.contains(id.as_str()) || !coordinate(point.x) || !coordinate(point.y) {
                return fail("视图引用不存在的节点或坐标无效");
            }
        }
    }
    if p.views.tree.positions.len() != ids.len() {
        return fail("树视图必须包含所有节点坐标");
    }
    let mut folded = HashSet::new();
    for id in &p.views.tree.collapsed_ids {
        if !ids.contains(id.as_str()) || !folded.insert(id) { return fail("折叠节点缺失或重复"); }
    }
    let mut edge_ids = HashSet::new();
    for edge in &p.views.graph.edges {
        if !valid_node_id(&edge.id) || !edge_ids.insert(&edge.id) { return fail("图边 ID 无效或重复"); }
        if !p.views.graph.positions.contains_key(&edge.source) || !p.views.graph.positions.contains_key(&edge.target) { return fail("图边端点必须属于图视图"); }
        if edge.label.as_ref().is_some_and(|label| !valid_title(label)) { return fail("图边说明无效"); }
    }
    let parents: HashMap<&str, Option<&str>> = p
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n.parent_id.as_deref()))
        .collect();
    let mut finished = HashSet::new();
    for n in &p.nodes {
        if let Some(parent) = &n.parent_id {
            if parent == &n.id || !ids.contains(parent.as_str()) {
                return fail("父节点缺失或节点自连");
            }
        }
        let mut visiting = HashSet::new();
        let mut current = Some(n.id.as_str());
        while let Some(id) = current {
            if finished.contains(id) {
                break;
            }
            if !visiting.insert(id) {
                return fail("禁止循环父子关系");
            }
            current = parents.get(id).copied().flatten();
        }
        finished.extend(visiting);
    }
    Ok(())
}

#[cfg(test)]
pub fn sample() -> String {
    serde_json::json!({"format":"forest-project","version":3,"projectId":Uuid::new_v4().to_string(),"name":"测试项目","views":{"tree":{"positions":{},"collapsedIds":[],"viewport":{"x":0,"y":0,"zoom":1}},"graph":{"positions":{},"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}},"nodes":[]}).to_string()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_version_and_unknown_fields_are_rejected() {
        let s = sample();
        assert!(parse(&s).is_ok());
        assert!(parse(&s.replace("forest-project", "other")).is_err());
        assert!(parse(&s.replace("\"version\":3", "\"version\":99")).is_err());
        let mut v: serde_json::Value = serde_json::from_str(&s).unwrap();
        v["selected"] = true.into();
        assert!(parse(&v.to_string()).is_err());
    }
    #[test]
    fn windows_names() {
        for n in [
            "CON",
            "nul.md",
            "COM1.md",
            "LPT².md",
            "a/b.md",
            "a.md ",
            "a:stream.md",
        ] {
            assert!(!valid_filename(n), "{n}");
        }
        assert!(valid_filename("数据结构.json"));
    }
    #[test]
    fn v3_accepts_unicode_linked_paths() {
        let paths = [
            "a中文/文件.txt",
            "b日本語/資料.md",
            "c🚀/notes.txt",
            r"D:\中文目录\笔记.md",
            r"\\server\share\日本語\資料.md",
        ];
        let raw = include_str!("../../tests/fixtures/project-v3.json");
        let mut value: serde_json::Value = serde_json::from_str(raw).unwrap();
        value["nodes"][0]["linkedPaths"] = serde_json::json!(paths);

        let project = parse(&value.to_string()).unwrap();
        assert_eq!(project.nodes[0].linked_paths.as_deref().unwrap(), paths);
        assert_eq!(parse(&serde_json::to_string(&project).unwrap()).unwrap(), project);
    }
    #[test]
    fn rejects_invalid_colon_in_unicode_linked_paths() {
        for path in ["a中文:/文件.txt", "日本語:/資料.md", "D:/中文/文件:stream.txt"] {
            assert!(!valid_linked_path(path), "{path}");
        }
    }
    #[test]
    fn v3_shared_fixture_roundtrips_loops_cycles_and_independent_layouts() {
        let raw = include_str!("../../tests/fixtures/project-v3.json");
        let p = parse(raw).unwrap();
        assert_eq!(p.version, 3);
        assert_eq!(p.nodes[1].parent_id.as_deref(), Some("a"));
        assert_eq!(p.views.graph.edges.len(), 3);
        assert_eq!(p.views.graph.edges[0].source, p.views.graph.edges[0].target);
        assert_ne!(p.views.tree.positions["a"].x, p.views.graph.positions["a"].x);
        assert_eq!(parse(&serde_json::to_string(&p).unwrap()).unwrap(), p);
    }
    #[test]
    fn v3_rejects_legacy_fields_and_malformed_view_references() {
        let raw = include_str!("../../tests/fixtures/project-v3.json");
        let base: serde_json::Value = serde_json::from_str(raw).unwrap();
        for field in ["position", "collapsed", "documents", "folderPath"] {
            let mut v = base.clone();
            v["nodes"][0][field] = serde_json::json!(false);
            assert!(parse(&v.to_string()).is_err(), "{field}");
        }
        for version in [0, 1, 2, 4, 99] {
            let mut v = base.clone();
            v["version"] = version.into();
            assert!(parse(&v.to_string()).unwrap_err().contains("仅支持 V3"));
        }
        let mut bad = vec![];
        let mut v = base.clone(); v["schemaVersion"] = 2.into(); bad.push(v);
        let mut v = base.clone(); v["viewport"] = serde_json::json!({"x":0,"y":0,"zoom":1}); bad.push(v);
        let mut v = base.clone(); v["views"]["tree"]["positions"].as_object_mut().unwrap().remove("a"); bad.push(v);
        let mut v = base.clone(); v["views"]["graph"]["positions"]["ghost"] = serde_json::json!({"x":0,"y":0}); bad.push(v);
        let mut v = base.clone(); v["views"]["graph"]["positions"].as_object_mut().unwrap().remove("b"); bad.push(v);
        let mut v = base.clone(); v["views"]["tree"]["collapsedIds"] = serde_json::json!(["a","a"]); bad.push(v);
        let mut v = base.clone(); v["views"]["tree"]["collapsedIds"] = serde_json::json!(["missing"]); bad.push(v);
        let mut v = base.clone(); v["views"]["graph"]["edges"][1]["id"] = "loop".into(); bad.push(v);
        let mut v = base.clone(); v["views"]["graph"]["edges"][0]["direction"] = "backward".into(); bad.push(v);
        let mut v = base.clone(); v["views"]["graph"]["edges"][0]["label"] = serde_json::Value::Null; bad.push(v);
        let mut v = base.clone(); v["views"]["graph"]["viewport"]["zoom"] = 0.into(); bad.push(v);
        let mut v = base.clone(); v["views"]["tree"]["positions"]["a"]["extra"] = true.into(); bad.push(v);
        let mut v = base.clone(); v["nodes"][0]["parentId"] = "b".into(); bad.push(v);
        for (i, v) in bad.into_iter().enumerate() { assert!(parse(&v.to_string()).is_err(), "invalid fixture {i}"); }
    }

}
