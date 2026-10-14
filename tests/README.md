# tests/ —— pi-gui 验证脚本索引

> 2026-10-07 A2 自仓库根目录迁入（原 37 裸奔 + 新增 verify-bundleguard）。
> **形态分两类**：外部实例型（要先用 `PI_GUI_CDP_PORT=<port> PI_GUI_USER_DATA=<独立目录>` 起测试实例再跑脚本，端口从 argv 传）；自闭环型（脚本自起自杀，直接 node 跑）。
> **冒烟套餐**：`npm test`（= `node tests/smoke.mjs`）——runner 为外部实例型脚本逐个起全新独立实例（9230+序号端口），串行执行，末尾汇总；详见 smoke.mjs 头注释（三条实测坑：按端口归属杀进程 / stdout 管道保持开放 / 轮询一律 node 侧）。
> **长尾约定**：结构性改动后手动跑相关脚本；跑前自觉清场（复位 localStorage、删测试收藏、必要 reload——同实例状态污染账见 AGENTS.md）。
> 手动跑外部实例型：`PI_GUI_CDP_PORT=9233 PI_GUI_USER_DATA="$TMP/pi-gui-manual" PI_GUI_TEST_CWD="$TMP/pi-gui-test-cwd" node_modules\.bin\electron .` 另开 `node tests/verify-xxx.mjs 9233`——**发消息的脚本务必带 PI_GUI_TEST_CWD**（会话落专用目录，不污染 owner 主实例侧栏）。

## 冒烟套餐成员（npm test，11 个）

| 脚本 | 测什么 | token |
|---|---|---|
| verify-ui | 界面基线（welcome/侧栏/输入区/CDP 注入 page） | 零 |
| verify-design | 右栏项目树+查看器+收藏+过滤 52 断言 | 零 |
| verify-projtree | 项目树右键/子目录登记工作区/点根语义 | 零 |
| verify-workspace | 工作区增删/切换/会话归档 | 零 |
| verify-todopanel | todo pane 形态与折叠记忆 | 零 |
| verify-slashfix | slash 菜单参数阶段不复活（断言不派发 Enter） | 零 |
| verify-draft | 会话草稿隔离（文字+附件互不串） | 零 |
| verify-multi-session | 任务运行中新建会话不打断（1 条真实短消息） | 极低 |
| verify-open-session | 历史会话打开渲染+续聊语义 | 零 |
| verify-r2 | 设置中心四面板（技能/MCP/模型/外观） | 零 |
| verify-bundleguard | A1 bundle 新鲜度守卫（自闭环，9228 三用例） | 零 |

## 长尾（结构性改动后手动跑）

| 脚本 | 测什么 | token | 备注 |
|---|---|---|---|
| verify-auto | PI_GUI_AUTOTEST 自动发消息链路 | 真实消息 | 外部实例型 |
| verify-close | UI 级关闭会话（与归档分离） | 零 | |
| verify-compact | /压缩菜单+session:compact IPC | 低 | 短会话诚实拒绝路径 |
| verify-defaultmodel | R4-3 星标设默认模型 | 零 | |
| verify-fjev | fast-jev 压缩端到端（GUI） | 中 | 构造带工具长会话 |
| verify-fjev-sdk | fast-jev 压缩 SDK 级（无 GUI） | 中 | inMemory 会话 |
| verify-hotfix | busy 红点/运行中输入 | 零 | |
| verify-jevauto | jev/auto 虚拟模型注册+下拉+兜底路由 | 低 | 依赖扩展已装 |
| verify-mcpform | R4-1 MCP 增删改表单 | 零 | |
| verify-modelsform | R4-2 models.json 表单 | 零 | |
| verify-msgmeta2 | 消息元信息行排版 | 零 | |
| verify-phase | 阶段化占位生命周期 | 零 | |
| verify-r3 | 入场动效+轮末 chip+ContextRing | 零 | 需模拟 no-preference |
| verify-rename | /rename+新会话免确认 | 低 | 临时会话起名耗 1 次调用 |
| verify-round2 | 零散 UI 回归 | 零 | |
| verify-settings | R1 扩展社区目录+装卸包 | 零 | 出站 pi.dev |
| verify-sidebar | 侧栏重排五项+会话搜索 | 零 | |
| verify-tokenbar | ContextRing 排版回归 | 零 | |
| verify-trayclose | 托盘驻留+关闭确认（自闭环 9225） | 零 | 真 WM_CLOSE/BM_CLICK |
| verify-switch-perf | 切换微卡：大会话分段渲染（尾段<450ms+完整性+滚动）；目标会话被清理时 SKIP | 零 | 依赖 Desktop 存量大会话 |
| verify-branchscan | D1 跨会话分支拾遗：扫描+导航+面板端到端（fixture 注入定向扫描） | 零 | 自造多分支 fixture |
| verify-guard | 安全①fs 白名单（工作区内可读/越界拒）+②路径守卫扩展八分支无头单元 | 零 | 真弹窗交互 owner 人工验收 |
| verify-pkgweekly | 每周插件精选：双源抓取（pi.dev+GitHub）+评分+面板+红点 | 零（仅抓目录页） | 出站 pi.dev/api.github.com；GitHub 限流 403 时降级社区源 |
| verify-uifix | 审计轮对齐/对比度/字号 | 零 | |
| verify-usagechip-removal | 用量 chip 移除回归 | 零 | |
| verify-visionauto | 带图自动切视觉模型 | 低 | 模型切换调用 |
| verify-zai-footer | zai 页脚断言（page 注入） | 零 | |
| review-desktop | 桌面端走查（人工辅助） | 零 | |

## page 伴随文件（被对应脚本 readFileSync 同目录加载）

- verify-page.js ← verify-ui
- verify-slashfix-page.js ← verify-slashfix
- verify-zai-footer-page.js ← verify-zai-footer
