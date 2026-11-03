# Magpie Dim OAuth

为 [Magpie](https://github.com/yetone/magpie) 接入 Dim OAuth 模型服务的独立插件，提供模型服务和 Dim 账户页面。

当前实现已使用模拟服务验证，尚待新的 OAuth 客户端注册和真实服务联调。
仓库 `arcships/magpie-dim-oauth` 当前保持私有，仅授权成员可访问。包名为
`@arcships/magpie-dim-oauth`，已设置 `private: true`，暂不发布 npm。

## 功能

- 浏览器 OAuth 登录，authorization code + PKCE S256，不发送 client secret。
- 由 Magpie 负责令牌保存、跨进程续期和多账号调度。
- 从账号模型目录读取协议、工具调用、输入模态、上下文长度和推理等级。
- Dim 账户页展示套餐、价格、到期时间、月度用量、限制窗口及重置倒计时。
- 展示重置次数及有效期，支持窗口重置和月度额度恢复：核对适用批次、明确确认、幂等提交。
- 提供购买、套餐续期和价格入口，打开当前账号服务商的官方网页。

要求 Magpie `0.1.2818` 或更新版本。插件没有运行时 npm 依赖，由 Magpie 的 Bun 宿主直接运行。

## 目标流程

```text
Magpie / Plugins
  -> Add local plugin
  -> Sign in with Dim
  -> Browser authorization
  +-> Agent model selection -> Magpie gateway -> Dim relay
  +-> Dim Account
      +-> Plan / usage / reset countdown
      +-> Purchase / renew -> Official subscription page
      +-> Reset details -> Confirmation -> Apply once
```

插件使用独立的新 OAuth client ID，不复用 DimCode、Desktop、Remote 或其他项目中的客户端注册。
新 ID 尚待提供；发行方、授权范围、回调地址和服务端客户端准入规则需要与该注册匹配。

## 本地安装与配置

```sh
magpie plugin add /Users/junyizhang/Git/magpie-dim-oauth
```

在 Magpie 配置目录 `plugins.json` 的本插件条目中设置 `options`。以下是配置格式示例，
`YOUR_NEW_CLIENT_ID` 必须替换为专门注册的新 ID；issuer、scope 和回调地址也必须与新注册一致：

```json
{
  "spec": "/Users/junyizhang/Git/magpie-dim-oauth",
  "options": {
    "issuer": "https://dimagent.com",
    "clientId": "YOUR_NEW_CLIENT_ID",
    "redirectUri": "http://127.0.0.1:54322/oauth/callback",
    "scope": "openid profile email",
    "port": 3488
  }
}
```

也可以通过宿主环境变量配置四项 OAuth 参数：`MAGPIE_DIM_ISSUER`、`MAGPIE_DIM_CLIENT_ID`、
`MAGPIE_DIM_REDIRECT_URI` 和 `MAGPIE_DIM_SCOPE`。插件 options 优先，**没有任何内置 client ID 或旧 ID 回退**。
本插件不自动读取 `.env` 文件；桌面进程未必继承终端环境，推荐使用 options。

回调仅监听 `127.0.0.1`，使用 HTTP 和已注册的明确端口；`port` 是账户页面服务的独立端口，
不应与 OAuth 回调、Magpie 网关或 Web 页面端口相同。配置后重新启用插件，再执行：

```sh
magpie plugin login dim-oauth
magpie provider test dim-oauth
magpie quota
```

在 Magpie 侧栏打开「Dim 账户」。页面通过 Magpie 本地网关的用量刷新接口加载账号并触发宿主续期；
需要 Magpie 应用或 `magpie web` 正在运行。单独执行一次 CLI 命令不会留下常驻账户页面服务。

账户页的购买/续期按钮打开运行 Magpie 那台机器的默认浏览器。远程使用 `magpie web` 时，
可复制页面展示的套餐链接，在自己的浏览器访问。网页使用浏览器自己的登录态，不会将 OAuth token 放入 URL。

## 重置与用量

点击重置先读取当前套餐、可用次数和适用批次，只展示适用于目标订阅且未到期的次数。
批次服务不可用时会明确提示，并允许用户按汇总次数继续确认；成功读取但没有适用批次时不允许提交。
真正消费发生在确认之后，同一次确认的重复点击或重试使用同一个幂等键。

提交成功后直接使用返回的套餐桶、窗口和次数更新页面，不额外拉取用量。独立的功能额度保留；
服务端没有随重置返回账户总余额，页面不会推算它，下一次手动刷新再读取。
出现网络失败时，在原确认框重试以复用幂等键。

用量窗口用于展示。由于订阅桶和加量包的可用范围不能等同于整个账号的限制，
插件不使用这些展示窗口自动禁用账号；是否可调用仍由服务端与 Magpie 请求结果决定。

## 开发与验证

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

可选：使用已下载的官方 Magpie CLI 运行隔离集成测试，测试只访问本地模拟服务：

```sh
MAGPIE_TEST_BINARY=/absolute/path/to/magpie bun test
```

该测试使用临时 HOME、配置和缓存目录，验证安装、模型目录、令牌续期和账户页面接入。
不修改已有 Magpie 或 agent 配置，不调用真实付费模型。

账号令牌仅由 Magpie 保存在其 `plugin-auth.json` 中；页面只接收不含令牌的账号信息。
本插件不读取 DimCode、Desktop 或其他应用的账号文件。所有模型请求只允许发往当前账号 issuer 的 relay，
重定向不会携带令牌继续转发。服务端仍需允许新插件的客户端身份；本插件使用自己的
`magpie-dim-oauth/0.1.0` 请求标识，不冒用现有官方客户端。

详细分析与待验证条件见 [接入设计](docs/integration.md)。
