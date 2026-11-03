# 公开后的 Magpie 上架步骤

2026-11-03 已将 `arcships/magpie-dim-oauth` 公开，并添加 GitHub Topic `magpie-plugin`。
已验证匿名读取根目录 package.json，以及 GitHub 按 Magpie Topic 条件搜索命中仓库。
尚未创建版本 tag 或 Release、发布 npm，也没有提交社区推荐列表收录 PR。

## 官方所说的 tag 是什么

让 GitHub 仓库出现在 Magpie 的发现列表，需要的是 GitHub 仓库 **Topic：`magpie-plugin`**，而不是 `v0.1.0` 这样的 Git 版本 tag。

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

## 版本 tag 与 Release：用于记录版本，不是发现列表的前提

正式版本可以另建 `v0.1.0` tag 和 GitHub Release，让用户知道这次更新了什么。这一步在真实联调通过、版本确定后再做。

```sh
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0" --notes-file release-notes.md
```

执行前先编写并核对 `release-notes.md`；上面的命令是待办示例，尚未执行。

## 社区推荐列表（尚未申请）

这与 GitHub Topic 发现是两条路径。官方推荐列表来自 [magpie-community/plugins 的 registry.json](https://github.com/magpie-community/plugins/blob/main/registry.json)。需要向该仓库提交收录 PR，由社区决定是否合并；列表最多每六小时拉取一次。

若选择发布独立 npm 包，需要先取消 `package.json` 的 `private: true`、确认包名与发布权限，再按官方格式准备 registry 条目。
当前包名与关键词已包含 OpenCode 插件识别所需词，发布 npm 后也可以被 Magpie 的 npm 搜索发现。

本项目位于自己的组织下，不应声明为 `@magpie-community/*`，也不应在 registry 条目里标记 `community: true`。
准备收录 PR 前重新核对当时的官方规则，避免把“有 GitHub Topic”当成“已经经过社区审核”。
