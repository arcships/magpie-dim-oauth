# 公开后的 Magpie 上架步骤

2026-11-03 已将 `arcships/magpie-dim-oauth` 公开，并添加 GitHub Topic `magpie-plugin`。
已验证匿名读取根目录 package.json，以及 GitHub 按 Magpie Topic 条件搜索命中仓库。
本仓库只通过 GitHub 分发，不发布 npm。当前版本 `0.1.1`，正式发布使用对应的 `v0.1.1` annotated tag。
社区收录已提交 [PR #669](https://github.com/magpie-community/plugins/pull/669)；审核状态以该 PR 为准。

## 官方所说的 tag 是什么

让 GitHub 仓库出现在 Magpie 的发现列表，需要的是 GitHub 仓库 **Topic：`magpie-plugin`**，而不是 `v0.1.1` 这样的 Git 版本 tag。

Magpie 会搜索带这个 Topic 的仓库，展示在：

```text
Plugins → Discover → Unofficial, on GitHub
```

官方说明查询间隔最多为十分钟；GitHub 索引和网络异常也会影响出现时间。列表按 star 排序，并标记为未审核。
仓库已公开，用户可直接从 GitHub 安装；首次显示仍受 GitHub 索引和 Magpie 缓存更新时间影响。

依据：[官方插件文档](https://github.com/yetone/magpie/blob/bc10a619857aaec97fb31486f2b20bf8308637ee/site/public/docs/plugins.html) 的 “Publishing and listing / A GitHub topic”，以及 [GitHub 发现实现](https://github.com/yetone/magpie/blob/bc10a619857aaec97fb31486f2b20bf8308637ee/internal/plugin/github.go)。核对日期：2026-11-03。

## 发布检查与操作记录

1. 两站 OAuth client ID 已配置；本机已验证登录、用量查询和聊天模型调用。重置流程已有隔离测试，未消耗真实账号的重置次数。README 已整理为用户使用指南。
2. 保留根目录的 `package.json`，并把入口文件 `src/index.ts` 和它依赖的源文件一起提交。Magpie 从 GitHub 安装时直接读取仓库，不能只在发布时才生成入口。
3. 确认插件元数据中的 `magpie.icon` 和 `magpie.page.icon` 可用。当前使用随仓库提供的 Desktop 原图，插件卡片用内嵌 data URI，侧栏与 README 使用 `page/icon.png`。
4. 已添加 Topic：

   ```sh
   gh repo edit arcships/magpie-dim-oauth --add-topic magpie-plugin
   ```

5. 在 Magpie 的 `Plugins → Discover → Unofficial, on GitHub` 检查 Dim 插件，并从新配置目录实际安装、登录一次。刚添加 Topic 时留出索引与缓存更新时间。

当前仓库不是 fork，没有归档；入口与 `package.json` 均在 GitHub 安装可以读取的位置。
以后即使不发布 npm，也可以从 GitHub 安装：

```sh
magpie plugin add arcships/magpie-dim-oauth
```

## 正式版本发布

使用仓库内的 [release-plugin 技能](../.agents/skills/release-plugin/SKILL.md)。
本仓库正式发布必须完成版本号、校验、提交、annotated tag 和推送，不能仅修改 package.json。
当前 `0.1.1` 的 tag 为 `v0.1.1`。本次只创建 Git tag，不创建 GitHub Release，也不发布 npm。

这是本仓库的发布约定，不是 GitHub Topic 发现的前提。Magpie 对 GitHub 分支安装按提交检查更新；
用户点击 Update 或执行 `magpie plugin update` 获取更新。固定 tag 安装可以使用：

```sh
magpie plugin add 'arcships/magpie-dim-oauth#v0.1.1'
```

固定 tag 不会随着 main 移动。普通用户仍推荐使用不带 `#ref` 的仓库安装方式。

## 社区推荐列表（已提交 PR）

这与 GitHub Topic 发现是两条路径。官方推荐列表来自 [magpie-community/plugins 的 registry.json](https://github.com/magpie-community/plugins/blob/main/registry.json)。需要向该仓库提交收录 PR，由社区决定是否合并；列表最多每六小时拉取一次。

当前社区 registry 只接受 npm 包名，而本仓库不发布 npm。因此 PR #669 中的 npm 安装前置条件仍未满足，
不能把提交收录 PR 等同于用户已能通过 registry 安装；后续若需社区收录，应与维护者协调 GitHub 安装支持。
GitHub Topic 发现与直接从仓库安装不受该限制。

本项目由 DimAgent 官方在 arcships 组织维护，不应声明为 `@magpie-community/*`，
也不应在 registry 条目里标记 `community: true`。
