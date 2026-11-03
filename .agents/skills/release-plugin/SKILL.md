---
name: release-plugin
description: 发布本仓库的 DimAgent Magpie 插件；适用于升版本、发版、补发版本 tag。使用 GitHub 提交与 tag 分发，不发布 npm。
---

# Release the DimAgent plugin

在本仓库根目录执行。插件仓库为 `arcships/magpie-dim-oauth`，发布分支为 `main`。

## Release contract

- 用户已明确：**不发布 npm**。保留 `package.json` 的 `private: true`，不要执行 npm publish、修改 npm 凭据或为 registry 收录发布包。
- 正式 GitHub 版本必须同时具备版本号、对应提交和远端 annotated tag `v<version>`。只改版本号或只推代码不能算完成本仓库的正式发布。
- 这是本仓库的发布约定。Magpie 对默认分支安装按提交检查更新；GitHub Topic `magpie-plugin` 用于发现，二者不等于版本 tag。不要宣称所有用户必须有新 tag 才能更新。
- 本技能不自动创建 GitHub Release 或向社区发消息；只有当前请求包含这些操作时才执行。

## Workflow

1. 检查当前分支、工作区、远端和已有 tags；保留用户其它未提交修改。确认本次需要发布的插件修复已经包含在目标提交里。
2. 确定版本：用户给出版本则使用该版本；若当前版本已提升但还没有对应 tag，完成该版本，不再次递增。普通修复未指定版本时采用下一个 patch 版本；破坏兼容性的变更先明确版本范围。
3. 同步 `package.json.version`、`src/http.ts` 的 `magpie-dim-oauth/<version>` 请求标识，以及 `docs/setup.md` 中对应标识。检查锁文件是否实际包含根版本，仅在需要时修改。维持入口 `src/index.ts`、页面资源和安装方式可直接从 GitHub 读取。
4. 执行 `bun run typecheck`、`bun test`、`git diff --check`。本机有已验证的官方 Magpie CLI 时，使用 `MAGPIE_TEST_BINARY=<binary> bun test` 覆盖隔离安装流程；说明可选检查的跳过情况。不得为发版消耗真实模型或重置额度。相同代码已有的有效检查结果可复用。
5. 只提交本次发布需要的文件，提交说明使用英文；将提交推送到 `origin/main`。将发布约定、操作状态写入 `docs/distribution.md`，避免文档仍写着未执行或未申请。
6. 在已检查、已提交的目标提交创建并推送 annotated tag：

   ```sh
   git tag -a "v<version>" <commit> -m "DimAgent plugin v<version>"
   git push origin "v<version>"
   ```

   不重写已有 tag。若该 tag 已存在，核对其指向与版本内容；一致则复用，不一致时报告冲突，不删除或强推。
7. 用 `git ls-remote origin refs/heads/main 'refs/tags/v<version>*'` 核对远端分支及 tag 的 peeled commit；本地 `git rev-parse 'v<version>^{commit}'` 应与目标提交一致。报告版本、提交、tag 和检查结果。

## User update instructions

普通 GitHub 安装：`magpie plugin add arcships/magpie-dim-oauth`。
用户在 Magpie 中点击 Update，或执行 `magpie plugin update` 获取分支更新。
需要固定版本时使用 `magpie plugin add 'arcships/magpie-dim-oauth#v<version>'`；固定 tag 不会随着 main 更新。
外部插件不因公开、打 tag 或版本号改变而获得社区自有插件的自动更新待遇。
