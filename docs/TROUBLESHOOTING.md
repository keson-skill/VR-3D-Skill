# 故障排查

先运行：

```bash
npm run doctor -- --profile core
npm run check
```

需要输入、渲染或发布能力时改用 `input`、`render` 或 `release` 配置，并使用 `--output doctor.json` 保存诊断。

| 现象或错误 | 原因 | 处理 |
|---|---|---|
| `input_preparation_blocked` | 输入路线缺尺度、转换器、配准或必要 sidecar | 查看准备作业的 `blockers`，补对应证据后重跑同一幂等作业 |
| `spatial_validation_failed` | Schema、拓扑、开口、来源或冲突未通过 | 修正 Spatial JSON，重新生成验证报告 |
| `spatial_approval_required` | 批准缺失、过期、测试批准、签名不可信或哈希不一致 | 用准确的三份绑定文件在交互终端重新批准 |
| `idempotency_conflict` | 同一幂等键提交了不同作业定义 | 使用原定义恢复，或为真正的新请求使用新幂等键 |
| `handler_unavailable` | 定义使用非白名单处理器 | 只使用生产作业 Schema 中的六个处理器 |
| `blender_unavailable` | Worker 没有 Blender | 安装 Blender，确认 `doctor --profile render`，然后恢复作业 |
| Blender 超时 | 场景/采样过重或超时过短 | 检查场景预算；仅在有依据时把 `render_timeout_ms` 提高到最多 24 小时 |
| PDF 工具缺失 | Poppler 未完整安装 | 安装全部五个 Poppler 命令；只装 `pdfinfo` 不足 |
| 视频少于两帧 | 视频太短、损坏或抽帧间隔过大 | 使用更长视频或降低抽帧间隔 |
| 点云仅 `visualization_only` | 尺度、轴、平面质量或开口证据不充分 | 提供已确认单位/轴并人工复核；点云仍不自动证明隐藏结构 |
| Viewer 403 | 隐藏文件、穿越路径、符号链接越界或方法不允许 | 只请求 Viewer 根目录内的公开常规文件 |
| WebXR 不可用 | 非 HTTPS、浏览器/设备不支持或权限拒绝 | 使用安全上下文和兼容设备；保留桌面回退 |
| `delivery_ready: false` | 批准无效、精装缺资产清单或许可证未解决 | 按 `blockers` 修正，不要手改布尔值 |
| 候选构建退出 2 | 没有完整资格证据 | 这是预期行为；候选包不得当作正式生产包 |
| 生产构建拒绝 dirty tree | 源码或未忽略文件改变 | 提交正确变更并清理生成文件；不要用 `--allow-dirty` 生产发布 |
| production 工作流缺资格包 | 未设置、损坏或提交不匹配的 `P10_QUALIFICATION_BUNDLE_BASE64` | 按 `docs/QUALIFICATION.md` 组装并验证外部资格包，再用编码脚本写入受保护 secret；不要把资格包提交到仓库 |

作业疑似损坏时：

```bash
npm run job -- --action verify --job-id <job-id> --store runs/runtime
```

`job.audit_hash` 表示事件链被改变；`job.checkpoint_hash` 表示检查点与记录不一致。不要直接修补哈希。恢复可信备份或重新执行受影响阶段，并保存原目录供审计。

安全扫描只在报告中保存可疑内容的哈希，不回显密钥。如果密钥曾进入文件或日志，即使随后删除，也应在供应商侧立即撤销并轮换。
