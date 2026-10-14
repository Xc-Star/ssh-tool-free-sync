export default {
  searchPlaceholder: '按名称、脚本或标签搜索代码片段',
  newSnippet: '新建代码片段',
  allTags: '全部',
  run: '运行…',
  copyScript: '复制脚本',
  scriptCopied: '脚本已复制到剪贴板',
  duplicated: '已复制代码片段',
  emptyTitle: '还没有代码片段',
  emptyDescription:
    '保存常用的命令和脚本，一键在一台或多台主机上运行，也可以在任意终端的代码片段面板中使用。',
  noMatch: '没有匹配的代码片段',
  clearFilters: '清除筛选',
  lines_other: '{{count}} 行',

  // editor
  newTitle: '新建代码片段',
  editTitle: '编辑代码片段',
  label: '名称',
  labelPlaceholder: '例如：重启 nginx',
  script: '脚本',
  scriptPlaceholder: '# 要执行的命令，每行一条',
  scriptHint: '会像手动输入一样发送到终端，每一行依次执行。',
  tags: '标签',
  tagsPlaceholder: '添加标签…',
  tagsHint: '按回车或逗号添加标签。',
  removeTag: '移除标签 {{tag}}',
  suggestions: '已有标签',
  saveShortcut: '按 {{key}} 保存',
  errors: {
    label: '请输入名称',
    script: '脚本不能为空',
    tooManyTags: '每个代码片段最多 {{max}} 个标签'
  },

  // run dialog
  runTitle: '运行“{{name}}”',
  runDescription: '选择要运行此代码片段的主机。每台主机会在新的终端标签页中打开，连接成功后执行脚本。',
  hosts: '主机',
  hostsSearch: '搜索主机…',
  selectedCount: '已选 {{count}} 台',
  noHosts: '还没有 SSH 主机，请先添加主机。',
  noHostsMatch: '没有匹配的主机',
  runOn_other: '在 {{count}} 台主机上运行',
  runInCurrent: '在当前终端运行',
  runInSession: '在已打开的会话中运行',
  openFailed: '无法打开到 {{name}} 的会话'
}
