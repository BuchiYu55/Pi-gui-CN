---
name: implement
description: "Implement a piece of work based on a spec or set of tickets. 中文触发：按规格实现/按票据开工/实现这张票。"
disable-model-invocation: true
---

> 来源：mattpocock/skills（MIT），2026-10-11 移植入 pi。本地适配：Skill 工具引用改为「有对应 skill 就显式 / 调用，无则按其纪律执行」。

Implement the work described by the user in the spec or tickets.

- If the user passes a ticket reference, read the ticket file under `.agents/artifacts/*/tickets/` and state its title before starting. If the reference is ambiguous, ask. For a spec, read `.agents/artifacts/<slug>/spec.md`.
- Work the **frontier** when given a ticket set: any ticket whose blockers are all done.
- Follow the /tdd discipline（red → green，pre-agreed seams）where possible；无 /tdd 时按「先失败测试再实现、一次一片」执行。
- Run typechecking regularly, single test files regularly, and the full test suite once at the end.
- Once done, run /code-review（双轴评审）on the work；无 /code-review 时按「标准轴+规格轴」两路 spawn_subagent 并行评审。
- Commit your work to the current branch. 提交信息不以 `/` 开头；提交前 `git diff --staged` 扫有无裹挟他人未提交改动（pi-gui 仓库纪律）。
