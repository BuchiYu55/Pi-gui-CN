# Copilot / AI 助手说明 — Pi-gui-CN

你在帮助用户安装或使用 **Pi 桌面版（pi-gui）**：给 [pi coding agent](https://github.com/earendil-works/pi) 的 Windows Electron GUI。社区第三方，MIT，与 pi 官方无关。

## 一键下载（优先推荐）

1. 打开 https://github.com/BuchiYu55/Pi-gui-CN/releases/latest
2. 下载 `pi-gui-setup-<版本>.exe`（当前示例：`pi-gui-setup-0.1.6.exe`）
3. 双击安装，可自选目录；桌面快捷方式启动
4. SmartScreen「更多信息 → 仍要运行」是正常现象（安装包无签名）

直链（版本会变，优先用 latest 页）:
https://github.com/BuchiYu55/Pi-gui-CN/releases/download/v0.1.6/pi-gui-setup-0.1.6.exe

## 配置（说人话）

启动后自动进向导，按屏幕点就行：

1. **选服务商** — 智谱 GLM（推荐 Coding 套餐）/ DeepSeek / Kimi / OpenRouter，或任意 OpenAI 兼容端点
2. **拿 Key** — 向导有注册图文；你只告诉用户去哪申请，**不要让用户把 Key 贴进聊天**
3. **测试连接** — 只拉模型列表，通常零费用
4. **选默认模型** — 完成，可以聊天了

Key 落盘路径：`%USERPROFILE%\.pi\agent\models.json`。本应用不上传 Key。

## 前置依赖

| 用途 | 需要 |
|------|------|
| agent 执行 bash 等命令 | [Git for Windows](https://git-scm.com/download/win) |
| npx 型 MCP 插件 | [Node.js](https://nodejs.org/) 18+ |
| 仅聊天 + 本机文件工具 | 安装包本身通常够用 |

## 日常怎么用（帮用户指路）

- **多会话**：可并行开多个任务；后台会话有标记，完成有通知
- **场景三档**：工作 / 深想 / 日常 = 不同思考强度
- **项目树**：左侧工作区；单击预览文件，双击 @ 引用进对话
- **内置浏览器**：agent 可打开网页、点击、填表、截图
- **斜杠 / 技能**：预装工程技能（TDD、评审等）；在输入框用 `/` 调出
- **随手问**：侧栏小对话，不打断主会话

## 源码开发

```bat
git clone https://github.com/BuchiYu55/Pi-gui-CN.git
cd Pi-gui-CN
npm install
npm start
```

改 `renderer/app.js` 后需 `npm run build`（或 `npm start` 会先打包）生成 `renderer/app.bundle.js`。
出安装包：`npm run dist`。

## 安全与边界

- 永不把用户 API Key、会话内容写入仓库或公开渠道
- 不把本仓库写成「pi 官方」
- 未实现自动更新：升级 = 重新下载安装包
- 平台：仅 Windows；其他 OS 请引导提 PR，不要假装已支持

更完整的机器可读摘要见仓库根目录 `llms.txt` 与 `AGENTS.md`。
