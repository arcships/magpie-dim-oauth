# 内测配置与开发

当前登录配置尚未完成，以下内容供维护者在拿到新 client ID 后配置和联调。普通使用说明见 [README](../README.md)。

## 配置登录

在 Magpie 配置目录 `plugins.json` 的本插件条目中设置 `options`。以下是配置格式示例，
`YOUR_NEW_CLIENT_ID` 必须替换为专门注册的新 ID；issuer、scope 和回调地址也必须与新注册一致：

```json
{
  "spec": "/absolute/path/to/magpie-dim-oauth",
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

详细分析与待验证条件见 [接入设计](integration.md)。
