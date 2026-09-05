# Agent Note：可恢复的 Team 工作区与工作台账

Status: implemented

[English](2026-09-04-agent-team-workspaces-and-ledgers.md) | 中文

## 问题

共享 checkout 中的并发写入可能在受保护的文件系统工具之外相互覆盖。长期运行的 Team 还需要持久批次成员关系、有界的静默 worker 恢复，以及 worker commit 在集成前通过验证的依据。

## 决策

Worktree 与集成 provider 是实验性 Team 包中显式启用的子路径。它们随 Team 所有权共同演进，并提供完整的 service 注册、Git 实现和模型工具 Consumer。默认仍使用共享 checkout。本决策部分取代[持久 Agent Teams](2026-08-05-agent-teams.zh.md) 中仅使用共享 checkout 的决策；该记录继续拥有成员、mailbox、任务所有权和完成依据的决策权。

工作区所有权在 Git 变更之前记录。可继续运行的 child 在激活前将选定 cwd 写入 header，冷启动 follow-up 使用该持久 cwd。空闲 worker 保留其 worktree。释放会拒绝 live worker、未完成的所属任务、排队邮件、脏文件或被忽略的文件，以及尚未合并的 commit。接纳前失败的 spawn 可以释放干净的基础 checkout；已接纳或状态不确定的工作保持可恢复。Worktree 分离 checkout，但不授予或限制文件系统权限。

集成接纳固定 worker commit、目标 branch、候选目录和可执行验证命令。每个 Team 的单一 runner 在创建候选 checkout 前记录目标 commit。验证在候选目录运行，必须保持候选 commit 和已跟踪文件不变。已验证候选在推进目标前 flush。推进要求 Lead checkout 干净、位于配置的目标 branch，且目标 commit 符合预期；它使用 fast-forward，并能识别已经推进的候选。中断的验证成为失败记录并保留 checkout。不确定的推进保留已验证记录以便重试。显式放弃释放队列容量，但不删除依据。候选 checkout 保留供人工检查和清理。

Supervisor 以权威 child Session 事件数量判断进展。仍拥有未完成任务且未发生变化的 worker 可以被中断，并通过持久 mailbox 投递恢复。恢复接纳在中断前记录 compare-and-set 观察值和生命周期尝试次数。插件激活给予新的观察间隔，但不会重置持久重试预算。恢复保留任务所有权，绝不根据静默推断完成。

具名批次在 Lead 日志中保留任务 id 和单调 revision。进度从当前任务状态派生，因此重开已完成任务也会重新打开批次进度。活动批次阻止任务删除；归档批次保留对 tombstone 的引用。Service reload 和 Lead Session 恢复通过重放这些记录恢复状态，无需第二个数据库。

## Alternatives considered

拒绝为每个 subagent 隐式创建 worktree：仓库位置、branch 策略、验证命令和清理仍是显式部署选择。拒绝自动 reset、autostash、强制删除和未经验证的冲突解决，因为它们可能破坏或悄然修改其他写入者的产物。确定性的集成不需要专门的模型 agent；可选后台插件执行配置的检查，并将冲突保留给 Lead。

## Consequences

队列串行化一个 Team，而非任意外部 Git 写入者或多个 harness 进程。Git 自身的 ref 和 index 检查仍然适用。验证命令是受信任的部署代码，被忽略的构建产物可能留在保留的候选 checkout 中。系统不承诺跨越 Git 与 Session 日志的跨进程事务。

## 验证

临时 Git 仓库覆盖独立编辑、保守释放、固定源 commit、检查失败、脏目标、目标移动和合并冲突。Service 测试覆盖持久接纳阶段、已验证推进后的重试、队列容量、批次引用、恢复预算和销毁。Recorded-session 测试通过已提供的 profile 投影模型可见的任务和批次结果。Projection 测试拒绝畸形记录和无效阶段转换。
