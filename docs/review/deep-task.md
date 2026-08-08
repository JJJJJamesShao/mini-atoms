Role: reviewer
Goal: L3 深度评审——回答「这次改动在系统里对不对」。评审当前分支相对 main 的全部改动（git diff main...HEAD；若无已提交差异则评审工作区改动），结合整个仓库上下文。
Checklist（全维度逐项检查）:

1. 架构位置：改动在系统架构中所处的位置是否合理，是否放错了层/模块。
2. 模块一致性：与同类模块的模式、命名、结构是否一致；是否引入了与现有惯例冲突的新模式。
3. 冗余与重复造轮子：是否与已有模块/工具函数/依赖的能力重复；是否引入了不必要的抽象。
4. 潜在影响面：改动会影响哪些未变更的文件/流程/数据；接口变化是否同步了所有调用方；对 CI、hooks、脚本等基础设施有无副作用。
5. 规范符合度：是否符合仓库 README、AGENTS.md、分支命名、commit 规范、代码风格等明文规范。
   Output:

- 分 blocking / non-blocking 两级报告，每条注明对应的检查维度（1-5）。
- blocking：不修就不能合并的问题。non-blocking：建议项，注明「修复」或「列入已知问题」的建议。
  Acceptance: 返回 orch.result/reviewer/v1 JSON，blocking_findings 与 non_blocking_findings 均按上述分级填写。
