# 部署与运行

## 支持矩阵

| 平台 | Node.js | 状态 |
|---|---:|---|
| Linux x64/arm64 | 20、22 | CI 配置已建立，具体提交必须有运行证据 |
| macOS arm64/x64 | 20 | CI 配置已建立，具体提交必须有运行证据 |
| Windows x64 | 20 | CI 配置已建立，具体提交必须有运行证据 |

仓库配置不等于该提交已经通过三平台。只有 GitHub Actions 为同一提交生成且哈希验证通过的三个 `platform-evidence.json` 才可进入发布资格包。

## 最小部署

```bash
git clone <repository>
cd VR-3D-Skill
npm ci
npm run doctor -- --profile core
npm run check
```

生产主机应使用非管理员服务账户、独立工作目录、受限 `runs/` 和临时目录、足够磁盘配额，并把审阅者私钥放在仓库与运行目录之外。不要把 `.env`、客户输入、运行日志或生成交付物放进容器镜像或源码包。

## 可选本地工具

| 能力 | 工具 |
|---|---|
| OCR | Tesseract |
| PDF | Poppler：`pdfinfo`、`pdfimages`、`pdftotext`、`pdftocairo`、`pdftoppm` |
| 视频 | FFmpeg、FFprobe |
| XLSX | LibreOffice |
| LAS/LAZ/E57 | PDAL |
| IFC 几何转换 | IfcConvert |
| FBX 转换 | Assimp 或经过配置和批准的转换器 |
| 高质量渲染 | Blender |

工具缺失只关闭对应能力。`doctor` 不会把可选工具缺失误报为核心失败。

## 配置和凭据

从 `.env-example` 建立被 Git 忽略的 `.env`。按供应商拆分最小权限令牌，不把令牌注入 Viewer、GLB、日志或发布包。生产日志只记录稳定 ID、错误码、耗时、请求 ID、模型/工具版本和哈希；路径、邮箱、地址、鉴权头和密钥会被删减。

外部模型不是默认必需。每次调用还需要命令级 `--allow-provider`，上层系统不得自动补上该参数。

## 静态 Viewer

内置服务器只支持 GET/HEAD，拒绝隐藏文件、路径穿越、目录外符号链接和超长 URI，并返回 CSP、COOP、COEP、CORP、Permissions-Policy、Referrer-Policy 与 `nosniff`。它适合本地审阅；公网部署仍应放在受维护的 HTTPS 反向代理或静态托管平台之后，并配置身份验证、访问日志保留期和上传大小限制。

## 作业存储

生产运行时在 `runs/runtime` 下使用：

- `jobs/<job-id>/job.json`：原子状态记录；
- `jobs/<job-id>/events.jsonl`：哈希链审计事件；
- `jobs/<job-id>/checkpoints/`：逐阶段结果；
- `idempotency/`：幂等键的不可逆哈希绑定；
- 排他锁与陈旧锁恢复。

运行命令应显式使用 `--workspace runs`；所有处理器输出都必须位于该根目录，已有父目录和目录产物中的符号链接会被拒绝。锁包含随机所有权令牌，心跳绑定打开的文件句柄，旧持有者不会按路径误删他人的锁。

工作目录应位于可靠的本地或支持原子 rename 的卷。多主机共享文件系统不是当前已验证的分布式调度方案；需要水平扩展时，应在上层增加单写者队列和对象存储，而不是让多主机无协调地共享目录。

## 升级

1. 备份运行目录和外部信任根。
2. 在新提交执行 `npm ci`、`npm run doctor -- --profile release` 和 `npm run check`。
3. 对旧清单运行迁移 dry-run。
4. 审阅差异后使用 `--apply`；Spatial JSON/批准文件单独人工迁移并重新批准。
5. 在隔离环境恢复至少一个检查点作业。
6. 完成目标平台和设备资格后再切换正式流量。

## CI 与发布

`validate.yml` 在 Linux、macOS、Windows 和 Node 20/22 运行检查、依赖审计、P10 代码验收与 release doctor，并上传平台证据。所有第三方 action 固定到完整提交 SHA。`release.yml` 有两种模式：

- `candidate`：生成带哈希、SBOM 和明确“未资格”的候选包，预期状态码为 2；
- `production`：只允许实际稳定标签，必须从受保护的 `P10_QUALIFICATION_BUNDLE_BASE64` secret 取得同一提交的完整资格包，构建后再次验证包、SBOM、清单、标签和所有预检。

候选包失败为“未资格”是设计行为，不应通过忽略发布清单来改成正式包。
