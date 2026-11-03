<img src="page/icon.png" width="80" height="80" alt="Dim">

# 在 Magpie 里用 Dim

把你的 Dim 套餐接到 [Magpie](https://github.com/yetone/magpie) 里。登录 Dim 账号后，就能选用套餐提供的模型；想看还剩多少额度、续期套餐，或者重置用量，打开侧栏的「Dim 账户」就行。

还没有套餐？先去 [Dim 国内站购买或续期](https://dimagent.cn/console/subscription)，也可以使用 [Dim 海外站](https://dimagent.com/console/subscription)。选择你账号所在的站点即可。

> 目前是私有内测阶段，登录配置还在准备中。可以先安装插件，真实登录和模型调用需要等配置完成后再试。

## 先装到 Magpie 里

请使用 Magpie **0.1.2818 或更新版本**。

仓库目前是私有的，需要先有访问权限。用 GitHub CLI 登录后，把插件下载到本机：

```sh
gh repo clone arcships/magpie-dim-oauth
```

然后打开 Magpie 的 **Plugins（插件）** 页面，点击 **Add a plugin（添加插件）**，填入刚才下载的 `magpie-dim-oauth` 文件夹的完整路径。

习惯用终端的话，也可以在下载插件的目录里执行：

```sh
magpie plugin add ./magpie-dim-oauth
```

## 登录，然后选一个模型

1. 在 Magpie 的服务商列表里找到 **Dim OAuth**，点击 **Sign in with Dim**。
2. 在打开的浏览器中登录 Dim，并完成授权。
3. 回到 Magpie，等模型列表加载出来，再给你要使用的 Agent 选一个 Dim 模型。

能选哪些模型，以你当前账号和套餐实际提供的列表为准。

```text
Magpie
├─ 模型选择 → Dim OAuth → 选择套餐里的模型
└─ Dim 账户 → 看用量 / 重置额度 / 购买与续期
```

## 看额度，或者重置一下

打开 Magpie 侧栏的 **Dim 账户**，就能看到当前套餐、到期时间、已经用了多少额度，以及用量窗口还要多久重置。需要更新时，点右上角的 **刷新**。

如果账号里有重置次数，可以在这里操作：

- **重置用量窗口**：重置当前套餐的限制窗口。
- **恢复月度额度**：恢复当前计费月的套餐额度。

点击后会先显示目标套餐、可用次数和适用次数的有效期。确认没问题，再点 **消耗 1 次并重置**；点取消不会扣次数。

如果提交时网络出了问题，留在原来的确认框里重试就好，同一次操作不会重复扣次数。

## 购买或续期套餐

账户页里有 **购买套餐**、**续期套餐** 和 **查看价格** 按钮，会打开当前账号所在站点的官方页面。支付和续期都在官网完成。

你也可以直接打开：

| 站点 | 购买 / 续期 | 查看价格 |
| --- | --- | --- |
| 国内站 | [打开套餐页面](https://dimagent.cn/console/subscription) | [查看价格](https://dimagent.cn/console/pricing) |
| 海外站 | [打开套餐页面](https://dimagent.com/console/subscription) | [查看价格](https://dimagent.com/console/pricing) |

购买或续期完成后，回到 Magpie 的 **Dim 账户**，点一下 **刷新**。

## 遇到问题时

- **登录时提示缺少配置**：内测登录配置还没准备好，等维护者配置完成后再试。
- **授权后还没看到模型或账号**：先刷新 Dim OAuth 的用量，再重新打开「Dim 账户」。
- **重置按钮不能点**：检查账号是否有可重置的套餐，以及对应的重置次数是否还有剩余。
- **用远程 Magpie 时，购买页面没有在自己电脑上打开**：按钮会打开运行 Magpie 那台机器的浏览器。复制账户页里的套餐链接，在自己的浏览器打开即可。

维护者文档：[内测配置与开发](docs/setup.md) · [公开后的上架步骤](docs/distribution.md)
