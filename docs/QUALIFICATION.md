# P10 生产资格说明

## 四类证据不能互相替代

| 证据 | 证明什么 | 不证明什么 |
|---|---|---|
| 固定样例与单元测试 | 合同、错误边界、确定性和回归 | 真实设备性能 |
| 静态场景预算与核心基准 | GLB 规模、三角面/材质/纹理预算和当前宿主确定性 | 浏览器、GPU、XR 或 Blender 帧率 |
| 三平台 CI | 同一提交可在 Linux、macOS、Windows 安装和执行代码门禁 | 手机、头显、真实 GPU 和客户项目 |
| 真实设备/项目资格 | 目标硬件生命周期、性能、真实 Blender 和端到端交付 | 其他未测设备或未记录场景 |

## 1. 代码验收

```bash
npm run p10:fixtures
npm run p10:code-acceptance
```

代码验收通过时，报告仍应是：

- `acceptance_scope: code_only`
- `release_qualified: false`
- `stage_status_recommendation: ACCEPTANCE`

删除或改写这三个事实不能形成生产资格。

## 2. 三平台证据

`Validate Skill` 工作流在 Linux、macOS 和 Windows 上执行完整检查。`write-platform-evidence.mjs` 只允许在 GitHub Actions 中运行，并绑定：

- 当前提交 SHA；
- P10 代码验收哈希；
- 当前平台 release doctor 哈希；
- Node/操作系统架构；
- 工作流 URL和证据包哈希。

从同一提交的工作流下载三个平台证据。Node 22 的 Linux 任务是兼容性补充，不替代任一操作系统。

## 3. 真实目标资格

按 [performance-budgets.json](../config/performance-budgets.json) 分别在以下实际目标采集记录：

- `web_desktop`：桌面主机、真实 GPU 和目标浏览器；
- `web_mobile`：物理手机或平板，不接受桌面模拟；
- `web_xr`：物理 XR 头显，覆盖进入、退出、重进、跟踪丢失和控制器重连；
- `blender`：实际 Blender 版本、目标 GPU/CPU、渲染帧和交付物哈希。

校验：

```bash
node scripts/performance/validate-qualification.mjs \
  --input capture.json \
  --output qualification-report.json
```

记录必须显式声明 `actual_device_capture`、`synthetic: false`，绑定发布提交和场景产物，并达到对应预算。校验报告会保留硬件、软件、测量、生命周期检查、证据哈希及原始捕获记录的 `capture_record_sha256`；原始捕获记录必须和报告一起归档。Blender 记录还必须包含实际渲染引擎及 CPU 或 GPU 身份。

字段声明和哈希只能证明记录内部一致、可复算且绑定某个提交，不能单独证明设备真实存在。产品负责人必须核对原始采集文件、设备界面和执行过程；GitHub CI 记录也必须从实际工作流下载，不能手写替代。

## 4. 匿名真实项目

真实项目必须先生成 `delivery_ready: true` 的交付清单。移除客户姓名、地址、联系方式、原始文件名和不必要图像后，由产品负责人在交互终端执行：

```bash
npm run project:accept -- \
  --source-manifest source-manifest.json \
  --delivery-manifest delivery-manifest.json \
  --project-id anonymized-project-001 \
  --approver-id product-owner-001 \
  --commit <release-commit-sha> \
  --output artifacts/qualification/real-project-acceptance.json
```

命令要求工作树干净、当前 `HEAD` 与 `--commit` 完全一致，并由人工输入绑定提交、源清单、交付清单和批准人 ID 的确认摘要。把输出写到已忽略的 `artifacts/`，避免接受记录本身改变待发布提交。合成样例、自动化 fixture 或仅看截图不能满足这项门禁。

## 5. 组装资格包

```bash
npm run release:qualify -- \
  --commit <release-commit-sha> \
  --platform linux-platform-evidence.json \
  --platform darwin-platform-evidence.json \
  --platform win32-platform-evidence.json \
  --target web_desktop=desktop-qualification.json \
  --target web_mobile=mobile-qualification.json \
  --target web_xr=xr-qualification.json \
  --target blender=blender-qualification.json \
  --project artifacts/qualification/real-project-acceptance.json \
  --output artifacts/qualification/qualification-bundle.json
```

组装器会验证每份内嵌哈希、提交绑定、平台唯一性、四类目标、隐私复核和真实项目人工接受。资格包内嵌三份完整平台记录、四份完整目标报告及其原始捕获记录、完整真实项目接受记录；大体积录像、截图、性能跟踪和 Blender 产物仍在外部归档，以文件名和 SHA-256 绑定。压缩 JSON 必须不超过 32 KiB。

## 6. 严格验收与发布

```bash
npm run p10:acceptance -- \
  --qualification artifacts/qualification/qualification-bundle.json

npm run release:build -- \
  --qualification artifacts/qualification/qualification-bundle.json

npm run release:verify -- \
  --manifest dist/vr-3d-skill-<version>.release.json \
  --tag v<version>
```

只有三步均为 0、工作树干净且版本标签完全匹配，P10 才能从 `ACCEPTANCE` 改为 `COMPLETED`。

正式标签工作流不从仓库读取资格包，以免出现“证据必须绑定提交、提交又必须包含证据”的循环。组装后将验证通过的压缩包编码为受保护仓库 secret：

```bash
node scripts/release/encode-qualification-secret.mjs \
  --input artifacts/qualification/qualification-bundle.json \
  --commit <release-commit-sha> \
  | gh secret set P10_QUALIFICATION_BUNDLE_BASE64
```

然后再为同一提交创建与稳定 `package.json` 版本一致的 `v<version>` 标签。`release.yml` 在临时目录解码 secret、按 `GITHUB_SHA` 复验，并且只允许实际标签执行 production 模式。不要提交资格包、原始客户资料或设备捕获。

## 当前待执行资格

仓库当前没有提交以下真实证据：

- 同一最终提交的 Linux、macOS、Windows CI 三件套；
- 物理桌面、移动端、XR 和真实 Blender 资格报告；
- 至少一个匿名真实项目人工接受记录；
- 由这些记录组装并通过外部 secret 安全传入标签工作流的资格包。

因此当前只能生成发布候选，不能形成稳定生产发布结论。
