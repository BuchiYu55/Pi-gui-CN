---
name: rpi
description: "Research → Design → Implement 三相工作流：每相产物落盘 .agents/artifacts/<slug>/，相间停下给用户检查点。中文触发：rpi/分相做/先调研再设计再实现/大改动分步走。"
disable-model-invocation: true
---

> 来源：humanlayer/skills rpi（MIT）轻量单文件适配版，2026-10-11。省略原版 references/agents 体系；子代理一律 spawn_subagent（explore 档做代码勘察，verify 档做核查）。跨相自动编排不做（产品拍板）——相间续作=手动开新会话或压缩后，配 /handoff 交接。

# Research, Design, Implement

Use `.agents/artifacts/<task-slug>/`（kebab-case slug；目录已存在则沿用）as the task directory. Artifacts are working documents: 不主动 commit，用户要求才入库。

## Phase 1 — Research（产物 research.md）

- 问题定义 + 现状勘察：复杂跨模块问题拆 2-4 路并行 spawn_subagent（explore 档）再综合，单点问题单路即可。
- 相关文件、数据流、约束、既有方案清点；版本敏感事实按用户级 AGENTS 事实验证纪律（先搜、双源、Sources 尾注）。
- 完成判据：research.md 落盘，末尾必有「未决问题」一节。
- **检查点**：对话流停——贴 research.md 路径 + 未决问题清单，等用户意见后再进设计（文本停顿，不弹卡）。

## Phase 2 — Design（产物 design.md）

- 方案选型（≥2 案 + 取舍）、模块/接口/seam 决策、测试决策（对齐 /tdd 的 seam 纪律）。
- 关键决策若与项目既有约定/AGENTS 铁律冲突：停下提案，用户确认前不继续。
- 完成判据：design.md 落盘，含「实施顺序」与「测试计划」两节。
- **检查点**：同上，贴路径 + 待拍板决策点。

## Phase 3 — Implement

- 按 design.md 实施，走 /implement 纪律（tdd → typecheck → 全量 suite → /code-review 双轴 → commit）。
- 过程中的决策变更追加记入 decision.md（一行一条：决策/理由/日期）。
- 收尾按用户级 AGENTS 输出纪律：末条自包含（结果/涉及路径/下一步）；设计文档类落盘带 `## 信源` 段（design-gate 会拦）。

## 相间续作

新会话（或压缩后）先读 `.agents/artifacts/<slug>/` 内最新文档续作；跨会话用 /handoff 交接。需要用户决策的检查点一律对话流文本停顿，不作答依据不在对话流的场景不用弹窗。
