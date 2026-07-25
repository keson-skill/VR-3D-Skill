# VR-3D-Skill 用户指南

## 当前发布状态

当前版本是 `1.0.0-rc.1` 发布候选。P2-P9 功能已完成代码验收；P10 的生产代码门禁已建立，但在 Windows、macOS、物理手机、物理 XR 设备、真实 Blender/GPU 和匿名真实项目证据全部通过前，不得把它称为正式生产版本。

## 1. 安装与诊断

要求 Node.js 20 或 22：

```bash
npm ci
npm run doctor -- --profile core
npm run check
```

按任务选择诊断配置：

| 配置 | 必需能力 |
|---|---|
| `core` | Spatial JSON、验证、场景编译和 Viewer |
| `input` | `core` 加 Poppler 和 FFmpeg 输入路线 |
| `render` | `core` 加 Blender |
| `release` | Node、Git、npm、依赖、磁盘和临时目录 |

缺少可选工具不会被伪装成已执行；相应输入或渲染路线会返回阻断项。

## 2. 准备输入

统一入口会保存来源哈希、选择输入路线并生成结构化阻断项：

```bash
node scripts/orchestration/prepare-interior-job.mjs \
  --input inputs/plan.png \
  --output runs/project-001/input
```

可重复 `--input` 组合 CAD、图片、照片或目录。DWG、二进制点云、FBX 和 XLSX 只允许经过显式批准的本地转换器；外部模型任务还必须单独使用 `--allow-provider`，该开关只代表用户批准了本次命令涉及的供应商和准确数据范围。

每个源文件默认必须是常规非符号链接文件，并受单文件及总容量限制。原始客户资料和 `runs/` 不应提交到 Git。

## 3. 建立并批准空间

确定性路线先生成 Spatial JSON 草案。随后执行 Schema、几何和来源验证：

```bash
node scripts/validation/validate-spatial-json.mjs \
  --input runs/project-001/spatial.json \
  --output runs/project-001/spatial-validation.json
```

在本地校正界面检查源图叠加：

```bash
npm run review:spatial
```

批准必须由人类审阅者在交互终端中执行，并使用仓库外的 Ed25519 私钥：

```bash
npm run approve:spatial -- \
  --source-manifest runs/project-001/input/source-manifest.json \
  --spatial-json runs/project-001/spatial.json \
  --validation-report runs/project-001/spatial-validation.json \
  --signing-key /secure/reviewer-ed25519.pem \
  --key-id reviewer-001 \
  --output runs/project-001/spatial-approval.json
```

测试批准、失效密钥、哈希变化、未知尺度、冲突和未解决问题都不能进入生产场景。

## 4. 生成可视化结果

使用同一份批准空间生成三种模式：

```bash
node scripts/tasks/scene-generation/build-viewable-scene.mjs \
  --spatial-json runs/project-001/spatial.json \
  --source-manifest runs/project-001/input/source-manifest.json \
  --validation-report runs/project-001/spatial-validation.json \
  --approval runs/project-001/spatial-approval.json \
  --approval-trust config/spatial-approval-trust.json \
  --output runs/project-001/viewer \
  --mode furnished
```

| 模式 | 结果 |
|---|---|
| `shell` | 毛坯空间、墙体、洞口、地面和顶面 |
| `hard-furnishing` | 毛坯加墙地顶、固定柜体和硬装 |
| `furnished` | 硬装加家具、软装和经过解析的真实资产或明确代理 |

本地查看：

```bash
node scripts/serve-viewer.mjs --directory runs/project-001/viewer --port 4173
```

Viewer 提供桌面、触摸、第一人称和受支持浏览器的 WebXR 路线。WebXR 需要 HTTPS、安全上下文、浏览器权限和真实兼容设备。

## 5. 生产任务运行时

[生产作业示例](../examples/production-job-definition.example.json)只使用白名单处理器，不提供任意 shell 执行：

```bash
npm run job -- \
  --action run \
  --definition examples/production-job-definition.example.json \
  --store runs/runtime \
  --workspace runs
```

查询、校验与取消：

```bash
npm run job -- --action list --store runs/runtime
npm run job -- --action status --job-id job-project-001 --store runs/runtime
npm run job -- --action verify --job-id job-project-001 --store runs/runtime
npm run job -- --action cancel --job-id job-project-001 --store runs/runtime
```

相同幂等键和相同定义会恢复原作业；同一幂等键绑定不同定义会拒绝。失败阶段按受限指数退避重试，成功阶段从哈希检查点恢复。所有输出必须位于 `--workspace`，符号链接穿越会被拒绝。批准、缺依赖或输入阻断会进入 `awaiting_approval` 或 `blocked`，修复证据后重跑同一作业即可继续。

## 6. Blender、多视角与全景

`npm run doctor -- --profile render` 必须通过。Blender 后台任务受无 shell 执行、输出上限和最长 24 小时超时约束；默认超时 2 小时。交付包括 `.blend`、静帧、2:1 全景、可选漫游、播放器及逐文件 SHA-256。

## 7. 正式交付清单

正式交付必须显式列出批准链和每个产物，不能递归打包整个客户目录：

```bash
npm run delivery:manifest -- \
  --root runs/project-001 \
  --project-id project-001 \
  --revision rev-001 \
  --scope visualization_only \
  --mode furnished \
  --binding source_manifest=input/source-manifest.json \
  --binding spatial_json=spatial.json \
  --binding validation_report=spatial-validation.json \
  --binding approval=spatial-approval.json \
  --binding approval_trust=spatial-approval-trust.json \
  --asset-manifest asset-manifest.json \
  --artifact scene=viewer/scene.glb \
  --artifact viewer=viewer/index.html \
  --output runs/project-001/delivery-manifest.json
```

精装交付缺少资产清单、许可证为空、`forbidden` 或 `verify_before_distribution` 时会阻断。`visualization_only` 会自动携带禁止用于施工、结构、法规、采购和精确放样的说明。

## 8. 修改、迁移与升级

自然语言修改先转成稳定 ID/JSON Pointer 补丁，再由确定性修订引擎应用、验证、记录差异并使旧批准失效。不要直接编辑已交付网格来代替 Spatial JSON 修订。

迁移默认只预览：

```bash
npm run migrate -- --input legacy-job.json
npm run migrate -- --input legacy-job.json --output migrated-job.json --apply
```

原地迁移会建立排他备份。Spatial JSON 和批准文件永不自动迁移，必须按目标 Schema 人工复核。
