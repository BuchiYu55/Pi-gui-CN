# AGENTS.md — 给 AI / 自动化助手

本文告诉你：**怎么帮用户一键装上、配好、用起 Pi 桌面版（pi-gui）**。说人话；需要机器读的字段见文末与 `llms.txt`。

人类产品说明见 [README.md](README.md)。Copilot 简版见 [.github/copilot-instructions.md](.github/copilot-instructions.md)。

---

## 这是什么

| 字段 | 值 |
|------|-----|
| 名称 | Pi 桌面版 / pi-gui |
| 仓库 | https://github.com/BuchiYu55/Pi-gui-CN |
| 关系 | 社区第三方 Electron GUI，包一层 [pi coding agent](https://github.com/earendil-works/pi)；**非官方** |
| 许可 | MIT |
| 平台 | Windows 10/11（仅此） |
| 数据目录 | `~/.pi/agent`（与 pi TUI 共用） |

---

## 一键下载（默认路线）

**目标**：用户 5 分钟内能聊天，不走源码。

1. 打开发布页：https://github.com/BuchiYu55/Pi-gui-CN/releases/latest  
2. 下载资产：`pi-gui-setup-<version>.exe`  
3. 双击安装（可改目录）→ 桌面图标启动  
4. SmartScreen 若拦截 →「更多信息」→「仍要运行」（无签名，预期行为）

当前已知直链（版本会变，**优先 latest 页**）：

```
https://github.com/BuchiYu55/Pi-gui-CN/releases/download/v0.1.6/pi-gui-setup-0.1.6.exe
```

PowerShell 示例（仅在用户明确要求自动下载时使用）：

```powershell
$uri = 'https://github.com/BuchiYu55/Pi-gui-CN/releases/download/v0.1.6/pi-gui-setup-0.1.6.exe'
$out = Join-Path $env:USERPROFILE 'Downloads\pi-gui-setup-0.1.6.exe'
Invoke-WebRequest -Uri $uri -OutFile $out
Start-Process $out
```

---

## 配置向导（首次启动）

应用会自动弹出向导，按顺序：

1. **选服务商** — 智谱 GLM（推荐 Coding 套餐）/ DeepSeek / Kimi / OpenRouter / 自定义 OpenAI 兼容端点（中转、Ollama、vLLM…）
2. **申请 Key** — 向导内有图文；你只指路，**不要让用户把 Key 发到聊天里**
3. **测试连接** — 拉一次模型列表，通常 0 费用
4. **选默认模型** — 结束，开聊

Key 写入本机：

```
%USERPROFILE%\.pi\agent\models.json
```

本项目无上传 Key 的逻辑。计费由模型服务商结算。

### 前置依赖（按需）

- **Git for Windows** — agent 执行 bash 等完整能力需要：https://git-scm.com/download/win  
- **Node.js 18+** — 仅当用户要用 npx 拉起的 MCP 时：https://nodejs.org/

---

## 用法速查（用户问「怎么用」时）

- **多会话并行**：新会话开新任务；后台跑的有标记，完成有通知  
- **场景三档**：工作 / 深想 / 日常 = 思考强度；按模型能力自动夹紧档位  
- **项目文件树**：管理多个工作区；单击查看、双击 @ 引用进输入框  
- **内置浏览器**：agent 可 open/click/type/screenshot；也有人工浏览面板  
- **`/` 菜单与技能**：预装 TDD、评审等技能；输入 `/` 选择  
- **随手问**：侧栏辅助对话，不打断主会话  
- **权限档**：plan / default / full 等（在设置或会话相关 UI 中切换）

与 pi TUI 共用 `~/.pi/agent`：技能、MCP、会话可互通。没用过 TUI 无影响。

---

## 源码路线（开发者 / 贡献者）

```bat
git clone https://github.com/BuchiYu55/Pi-gui-CN.git
cd Pi-gui-CN
npm install
npm start
```

| 命令 | 作用 |
|------|------|
| `npm start` | esbuild 打包 renderer 后启动 Electron |
| `npm run build` | 只生成 `renderer/app.bundle.js` |
| `npm test` | 自动化验证（多数零 token） |
| `npm run dist` | electron-builder → `dist-out/pi-gui-setup-*.exe` |

**硬规则（改代码时）**

1. 改了 `renderer/app.js` 必须重新 build；否则 UI「看起来能点但没动态」——CORS/opaque origin，ESM 不能直接 `file://` 加载。  
2. Electron 若 `dist/` 为空，可手动：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`  
3. 密钥只经 pi SDK 读 `~/.pi/agent`，**禁止**把 key 写进仓库或日志。  
4. 渲染进程保持 contextIsolation + sandbox；preload 只暴露白名单 API。

---

## AI 行为边界（必须遵守）

- [ ] 默认推「Releases 安装包」，不要先逼用户 `npm install`  
- [ ] 不收集、不回显、不提交用户的 API Key  
- [ ] 不声称本项目为 pi 官方  
- [ ] 不声称支持 macOS/Linux（可引导 PR）  
- [ ] 不擅自清空 `~/.pi/agent` 或用户会话  
- [ ] 升级 = 重新下载安装包（无自动更新）  
- [ ] 杀毒误报：说明无签名 Electron 包常见，可对照源码自建

---

## 机器可读摘要

```yaml
name: pi-gui
title: Pi 桌面版
repo: https://github.com/BuchiYu55/Pi-gui-CN
license: MIT
official: false
platforms: [windows]
latest_release: https://github.com/BuchiYu55/Pi-gui-CN/releases/latest
installer_pattern: pi-gui-setup-*.exe
example_installer: https://github.com/BuchiYu55/Pi-gui-CN/releases/download/v0.1.6/pi-gui-setup-0.1.6.exe
config_wizard: true
credentials_path: "~/.pi/agent/models.json"
shared_with_pi_tui: true
requires_optional:
  git_for_windows: "full agent bash"
  node_18_plus: "npx MCP servers"
docs:
  human: README.md
  ai: AGENTS.md
  llms: llms.txt
  copilot: .github/copilot-instructions.md
```

更多一行入口：根目录 [llms.txt](llms.txt)。
