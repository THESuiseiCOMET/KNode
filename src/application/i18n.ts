import { ref } from 'vue'
export type Language = 'zh-CN' | 'en'
function initial(): Language {
  try {
    return localStorage.getItem('knode-language') === 'en' ? 'en' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}
export const language = ref<Language>(initial())
if (typeof document !== 'undefined') document.documentElement.lang = language.value
export function setLanguage(value: Language) {
  localStorage.setItem('knode-language', value)
  language.value = value
  document.documentElement.lang = value
}
export const english: Record<string, string> = {
  新建项目: 'New project',
  打开项目: 'Open project',
  重命名项目: 'Rename project',
  自动保存: 'Auto-save',
  项目名称: 'Project name',
  节点名称: 'Node name',
  节点权重: 'Node weight',
  节点颜色: 'Node color',
  未命名项目: 'Untitled project',
  新节点: 'New node',
  新建根节点: 'New root node',
  新建子节点: 'New child node',
  重命名节点: 'Rename node',
  取消: 'Cancel',
  创建: 'Create',
  确认重命名: 'Rename',
  '处理中…': 'Working…',
  重试保存: 'Retry save',
  收起提示: 'Dismiss',
  重命名: 'Rename',
  节点属性: 'Node properties',
  带权重节点: 'Weighted node',
  无权重节点: 'Zero-weight node',
  选择子树: 'Select subtree',
  复制: 'Copy',
  剪切: 'Cut',
  删除: 'Delete',
  粘贴: 'Paste',
  断开连接: 'Disconnect',
  '权重 1': 'Weight 1',
  '权重 0': 'Weight 0',
  文件: 'Files',
  属性: 'Properties',
  节点文件: 'Node files',
  外部文件: 'Linked files',
  '新建内部 TXT 文件': 'New internal TXT file',
  '新建内部 Markdown 文件': 'New internal Markdown file',
  复制导入文件: 'Import file (copy)',
  复制导入文件夹: 'Import folder (copy)',
  '新建外部 TXT 文件': 'New external TXT file',
  '新建外部 Markdown 文件': 'New external Markdown file',
  关联已有文件: 'Link file',
  关联已有文件夹: 'Link folder',
  复制完整路径: 'Copy full path',
  打开项目文件夹: 'Open project folder',
  复制路径: 'Copy path',
  在资源管理器中显示: 'Show in Explorer',
  重命名内部文件: 'Rename internal file',
  删除内部文件: 'Delete internal file',
  解除关联: 'Unlink',
  重新关联: 'Relink',
  重新定位: 'Locate again',
  重试: 'Retry',
  '正在读取…': 'Loading…',
  确认: 'Confirm',
  文件名称: 'File name',
  包含扩展名: 'Include extension',
  不含扩展名: 'Without extension',
  未找到文件: 'File not found',
  从第一个节点开始: 'Start with your first node',
  '右键画布，创建带权重根节点或无权重根节点。': 'Right-click the canvas to create a root node.',
  搜索节点: 'Search nodes',
  清除搜索: 'Clear search',
  没有匹配节点: 'No matching nodes',
  撤销: 'Undo',
  重做: 'Redo',
  'AI 工作面板': 'AI workspace',
  设置: 'Settings',
  关闭: 'Close',
  通用: 'General',
  动画: 'Animation',
  'AI 服务': 'AI service',
  界面语言: 'Language',
  简体中文: '简体中文',
  展开与收起动画: 'Expand and collapse animation',
  'AI 服务提供商': 'AI provider',
  模型名称: 'Model name',
  测试连接: 'Test connection',
  保存配置: 'Save configuration',
  已保存: 'Saved',
  '已安全保存；留空保留原 Key': 'Stored securely; leave blank to keep the key',
  '外部 AI': 'External AI',
  'API 模式': 'API mode',
  需求: 'Request',
  生成提示词: 'Create prompt',
  复制提示词: 'Copy prompt',
  已复制: 'Copied',
  请先填写需求: 'Enter your request first',
  'API 生成尚未接入；可先在设置中配置并测试连接。':
    'API generation is not connected yet. Configure and test your service in Settings.',
  '外部模式仅生成提示词，不会伪造节点结果。':
    'External mode creates a prompt, not generated nodes.',
  最小化: 'Minimize',
  最大化: 'Maximize',
  还原窗口: 'Restore window',
  关闭窗口: 'Close window',
  应用菜单: 'App menu',
  'KNode 应用菜单': 'KNode app menu',
  已选: 'Selected',
  个节点: 'nodes',
  节点标题: 'Node name',
  搜索结果: 'Search results',
  文件操作: 'File actions',
  文件路径: 'File path',
  颜色明度: 'Brightness',
  有未保存修改: 'Unsaved changes',
}
Object.assign(english, {
  应用操作: 'App actions',
  '当前是浏览器预览。请用 npm run tauri dev 启动桌面版，使用本地项目读写。':
    'Browser preview. Start the Tauri desktop app for local project access.',
  从卡片边缘拖动连接: 'Drag from the card edge to connect',
  '按住 Alt 拖动可创建无向连线': 'Alt+drag to create an undirected connection',
  展开子树: 'Expand subtree',
  折叠子树: 'Collapse subtree',
  展开: 'Expand',
  折叠: 'Collapse',
  节点页面: 'Node panel',
  收起文件面板: 'Collapse files',
  打开文件面板: 'Open files',
  收起属性面板: 'Collapse properties',
  打开属性面板: 'Open properties',
  节点文件面板: 'Node files panel',
  节点属性面板: 'Node properties panel',
  '自动进度，只读': 'Automatic progress, read only',
  调整进度: 'Adjust progress',
  有效进度由带权子节点自动计算: 'Progress is calculated from weighted children',
  '拖动调整进度；方向键 ±1%，PageUp/PageDown ±10%，Home/End 设为 0/100%':
    'Drag to adjust; arrows ±1%, PageUp/PageDown ±10%, Home/End 0/100%',
  'HSV 色相饱和度圆盘': 'HSV hue and saturation wheel',
  '正在执行文件操作…': 'File operation in progress…',
  '删除内部文件…': 'Delete internal file…',
  解除所属关联: 'Unlink parent reference',
  '重新关联文件…': 'Relink file…',
  '重新关联文件夹…': 'Relink folder…',
  外部: 'external',
  内部: 'internal',
  树: 'tree',
  失效: 'Unavailable',
  '将由 Windows 确认并放入回收站。该文件操作不进入画布撤销历史。':
    'Windows will confirm moving this file to the Recycle Bin. File operations are not part of canvas undo history.',
  项目路径菜单: 'Project path menu',
  '连接成功，模型可用': 'Connected; model available',
  '连接成功，但服务模型清单中没有所选模型':
    'Connected, but the selected model is not listed by this service',
})
Object.assign(english, {
  新建文件: 'New file',
  项目名称无效: 'Invalid project name',
  '目录或JSON名称不匹配，不能确认专属项目目录':
    'Folder and JSON names do not match; this cannot be confirmed as a dedicated project directory',
  '项目目录包含其他文件，拒绝重命名整个目录':
    'The folder contains unrelated files; the directory will not be renamed',
  '同名目录已存在，不会覆盖': 'A folder with this name already exists; nothing was overwritten',
  模型名称: 'Model name',
})
Object.assign(english, { 个后代: 'descendants', 色槽: 'Color slot', 预设颜色: 'Preset color' })
Object.assign(english, { 选区强调色: 'Selection accent color' })
Object.assign(english, {
  '{count} 个选中节点': '{count} selected nodes',
  '仅删除{subject}？未选中的直接子节点将成为根；可通过画布撤销恢复。':
    'Delete only {subject}? Unselected direct children become roots. Canvas undo can restore the nodes.',
  '打开项目文件夹失败：': 'Could not open project folder: ',
  '复制路径失败：': 'Could not copy path: ',
  完整路径已复制: 'Full path copied',
  '文件操作失败：': 'File operation failed: ',
})
Object.assign(english, {
  最近打开的项目: 'Recently opened projects',
  暂无记录: 'No recent projects',
})
Object.assign(english, { 开发中: 'Under development' })
Object.assign(english, {
  '内部文件保留在 Nodes 目录，撤销可恢复节点；外部文件不受影响。':
    'Internal files stay in Nodes; undo restores the nodes. External files are untouched.',
})
Object.assign(english, {
  切换浅色模式: 'Switch to light mode',
  切换深色模式: 'Switch to dark mode',
})
Object.assign(english, {
  移除最近记录: 'Remove from recent projects',
  '仅移除记录，不删除项目文件': 'Remove this entry only; project files are kept',
  '最近记录无法保存，重启后可能恢复':
    'Recent list could not be saved; the entry may return after restart',
})
Object.assign(english, {
  关于: 'About',
  检查更新: 'Check for updates',
  '正在检查更新…': 'Checking for updates…',
  '已是最新版本。': 'You have the latest version.',
  '当前版本未配置签名更新。': 'Signed updates are not configured for this build.',
  '检查更新失败，请稍后重试。': 'Could not check for updates. Please try again later.',
  发现新版本: 'New version available',
  '正在保存项目并下载安装更新…': 'Saving the project and installing the update…',
  下载安装: 'Download and install',
  '安装更新失败：': 'Update installation failed: ',
  '请先完成当前编辑或文件操作，再安装更新。':
    'Finish the current edit or file operation before installing the update.',
  版本: 'Version',
  '如果 KNode 对你有帮助，欢迎在 GitHub 上给项目点个 Star。':
    'If KNode is useful to you, consider giving it a star on GitHub.',
  '如果你想参与 KNode 的开发，或有任何想法与建议，欢迎通过以下入口参与。':
    'If you would like to help develop KNode or share ideas and feedback, use the links below.',
  作者: 'Author',
  联系作者: 'Contact author',
  问题反馈: 'Report an issue',
  无法打开链接: 'Could not open the link',
})
Object.assign(english, {
  视图切换: 'Switch view',
  树视图: 'Tree view',
  图视图: 'Graph view',
  节点: 'node',
  新建节点: 'New node',
  图视图中还没有节点: 'No nodes in graph view yet',
  '右键画布创建节点。': 'Right-click the canvas to create a node.',
})
Object.assign(english, {
  自动整理: 'Auto arrange',
  布局: 'Layout',
  '布局方向：{direction} · 点击切换': 'Layout direction: {direction} · Click to switch',
  整理布局: 'Arrange layout',
  从上到下: 'Top to bottom',
  从下到上: 'Bottom to top',
  从左到右: 'Left to right',
  从右到左: 'Right to left',
})
Object.assign(english, { 树: 'Tree', 图: 'Graph' })
Object.assign(english, {
  开机时启动: 'Start at login',
  '开机启动设置失败：': 'Could not update startup setting: ',
})
export function t(text: string): string {
  return language.value === 'en' ? (english[text] ?? text) : text
}
