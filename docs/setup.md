# 内测配置与开发

两站的新 OAuth 客户端已配置，通常安装后即可选择站点登录，无需手动填写客户端信息。普通使用说明见 [README](../README.md)。

## 配置登录

当前内置配置如下，全部使用本插件专门注册的新 client ID：

| 站点 | issuer | client ID |
| --- | --- | --- |
| 国内 | `https://dimagent.cn` | `271706aab9b74b15a7140b228a419e4a` |
| 海外 | `https://dimagent.com` | `91975f99125f42bc88859100a1769ea4` |

两站均使用回调地址 `http://127.0.0.1:54322/oauth/callback`、scope `openid profile email`，
采用 public client 授权码流程，强制 PKCE S256，不发送 client secret。

如需覆盖默认值，在 Magpie 配置目录 `plugins.json` 的本插件条目中设置 `options`。以下以国内站为例：

```json
{
  "spec": "/absolute/path/to/magpie-dim-oauth",
  "options": {
    "issuer": "https://dimagent.cn",
    "clientId": "271706aab9b74b15a7140b228a419e4a",
    "redirectUri": "http://127.0.0.1:54322/oauth/callback",
    "scope": "openid profile email",
    "port": 3488
  }
}
```

也可以通过宿主环境变量配置四项 OAuth 参数：`MAGPIE_DIM_ISSUER`、`MAGPIE_DIM_CLIENT_ID`、
`MAGPIE_DIM_REDIRECT_URI` 和 `MAGPIE_DIM_SCOPE`。优先级为插件 options、环境变量、上表内置配置；不读取其他项目的 client ID。
本插件不自动读取 `.env` 文件；桌面进程未必继承终端环境，推荐使用 options。

两站均已启用登录入口。需要暂时关闭海外入口时，将 `options.global.clientId` 显式设为空字符串：
入口显示“海外站（敬请期待）”，点击只提示“敬请期待”，不请求授权端点。
海外站可以单独配置 `options.global` 的 `clientId`、`scope` 和 `redirectUri`；
其默认 issuer 为 `https://dimagent.com`。这四项也可分别通过 `MAGPIE_DIM_GLOBAL_CLIENT_ID`、
`MAGPIE_DIM_GLOBAL_SCOPE`、`MAGPIE_DIM_GLOBAL_REDIRECT_URI`、`MAGPIE_DIM_GLOBAL_ISSUER` 设置。
海外配置不会读取国内 client ID、scope 或回调地址。README 的介绍和购买链接只面向国内站。

2026-11-03 已核对两站的公开 OIDC 元数据及 S256 支持，并用上述注册、scope 和回调地址完成匿名授权预检：
两站均返回 HTTP 302，跳转到各自的 `/oauth-login`。这不等于完成了真实账号登录、模型调用或额度重置验收。

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
