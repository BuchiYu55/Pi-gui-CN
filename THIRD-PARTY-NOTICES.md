# 第三方组件与内容致谢

本项目（pi-gui）基于以下开源项目构建/移植，感谢原作者：

## 运行时依赖

| 组件 | 用途 | 许可证 |
|---|---|---|
| [pi coding agent（@earendil-works/pi-coding-agent）](https://github.com/earendil-works/pi) | Agent 核心运行时 | MIT |
| [Electron](https://www.electronjs.org/) | 桌面壳 | MIT |
| [esbuild](https://esbuild.github.io/) | 渲染端打包 | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Markdown 消毒 | Apache-2.0 / MPL-2.0 |
| [marked](https://marked.js.org/) | Markdown 解析 | MIT |
| [highlight.js](https://highlightjs.org/) | 代码高亮 | BSD-3-Clause |
| [electron-builder](https://www.electron.build/) | 安装包构建 | MIT |

## 内置技能（skills-builtin/）

以下技能移植自开源社区并做了中文/本地化适配，均保留原许可证（MIT）与来源注：

- **mattpocock/skills** 系列：code-review、diagnosing-bugs、handoff、implement、tdd、to-spec、to-tickets、writing-for-agents —— 来源 [mattpocock/skills](https://github.com/mattpocock/skills)（MIT）
- **emilkowalski/skills** 系列：break-ui、find-animation-opportunities、review-animations —— 来源 [emilkowalski/skills](https://github.com/emilkowalski/skills)（MIT）
- **humanlayer/skills**：rpi（轻量单文件适配版）—— 来源 [humanlayer/skills](https://github.com/humanlayer/skills)（MIT）

各技能目录内 `SKILL.md` 头部保留具体来源与适配说明。

## 完整依赖清单

见 `package.json` 与 `package-lock.json`；运行时依赖的许可证以 npm 注册表登记为准。
