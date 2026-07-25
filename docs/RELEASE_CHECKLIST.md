# 发布清单

## 代码冻结

- [ ] `package.json` 与 lockfile 版本一致。
- [ ] `npm ci`、`npm run check`、`npm audit --omit=dev --audit-level=high` 通过。
- [ ] `npm run p10:code-acceptance` 通过且 30 个固定样例零错误。
- [ ] 安全、隐私、许可证扫描零 blocker。
- [ ] 所有 GitHub Actions `uses:` 均固定为完整提交 SHA。
- [ ] 工作树干净，发布提交已确定。
- [ ] SBOM 已生成并覆盖全部锁定组件、唯一组件引用和依赖图。
- [ ] Sharp/libvips 等条件分发依赖的许可证通知和再分发义务已由发布负责人/法务确认。

## 跨平台与性能

- [ ] Linux 平台证据绑定发布提交。
- [ ] macOS 平台证据绑定发布提交。
- [ ] Windows 平台证据绑定发布提交。
- [ ] 物理桌面浏览器资格通过。
- [ ] 物理移动设备资格通过。
- [ ] 物理 XR 头显生命周期与性能资格通过。
- [ ] 真实 Blender/GPU 渲染资格通过。
- [ ] 所有报告达到 `config/performance-budgets.json`。

## 真实项目与交付

- [ ] 至少一个获授权真实项目已匿名化。
- [ ] 来源、Spatial JSON、验证、人工批准和信任根哈希一致。
- [ ] 毛坯/硬装/精装目标交付已按项目范围验证。
- [ ] Viewer、GLB、多视角、全景和 Blender 交付按需求实测。
- [ ] 资产许可证无缺失、禁止或待分发核验状态。
- [ ] 交付清单 `delivery_ready: true`。
- [ ] 产品负责人完成交互式真实项目接受。

## 发布

- [ ] 资格组装器验证三平台、四目标和真实项目。
- [ ] 完整资格包绑定最终提交、压缩后不超过 32 KiB，并已存入受保护的 `P10_QUALIFICATION_BUNDLE_BASE64` secret；仓库不提交资格包或原始捕获。
- [ ] 严格 P10 验收返回 0，并推荐 `COMPLETED`。
- [ ] 生产构建返回 0，清单 `release_ready: true`。
- [ ] 发布验证绑定包、SBOM、清单、提交和 `v<package-version>` 标签。
- [ ] `CHANGELOG.md`、用户指南、部署、排障与限制已更新。
- [ ] 只有以上全部满足后，需求文档才把 P10 改为 `COMPLETED`。

任何一项未完成时，只能发布带明确非声明的候选包；不得手工改写证据、跳过退出码或创建稳定标签。
