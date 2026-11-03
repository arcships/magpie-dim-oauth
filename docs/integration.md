# Magpie Dim OAuth 接入分析

日期：2026-11-03。状态：两站新客户端已配置，匿名授权预检通过；待真实账号与模型服务联调。

## 上游依据

分析基于 Magpie main 提交 `e41ef6288c9b4014daab8da2421612f496fa27b4`。

- [插件作者文档](https://github.com/yetone/magpie/blob/e41ef6288c9b4014daab8da2421612f496fa27b4/site/public/docs/plugins.html)
- [服务商插件边界](https://github.com/yetone/magpie/blob/e41ef6288c9b4014daab8da2421612f496fa27b4/docs/subsystems/provider-plugins.md)
- [社区插件](https://github.com/magpie-community/plugins)

Magpie 是 Go 编写的本地模型网关，外部服务商插件运行在 Bun 中，采用 OpenCode v1 插件形状。
插件可以是 npm 包、Git 仓库或本地目录，支持直接加载 TypeScript。
本项目采用外部服务商插件接口，无需修改 Magpie 的 Go 内置插件运行时。

## 职责划分

| 接口 | 插件职责 |
| --- | --- |
| `config` | 声明独立 provider、名称和 API 类型，尊重用户已有配置 |
| `auth.methods` | 启动 Dim OAuth 登录并完成授权交换 |
| `auth.refresh` | 续期令牌，明确标记不可恢复的授权过期 |
| `auth.loader` | 提供请求地址和鉴权 fetch，透传取消信号、响应状态与流 |
| `provider.models` | 按当前账号获取模型和能力，映射为 Magpie 模型结构 |
| `auth.usage` | 将真实套餐额度映射为 Magpie 用量窗口，并登记宿主账号的读取能力 |
| 本地账户页服务 | 在账号作用域内查询套餐与重置次数、执行经确认的重置、打开官方购买/续期页面 |

Magpie 负责网关协议转换、路由、多账号调度和失败转移。
令牌使用 Magpie 的账号存储；不读取已有 DimCode 登录文件，不建立第二套凭据仓库。
账户页保存的是宿主 `getAuth` 读取能力，而非另存的 token。操作保持宿主账号与代理作用域；
发现账号已退出或切换时拒绝继续使用旧记录。
入口只导出插件函数，避免辅助函数被宿主当作插件执行。

## Dim 接口现状

以下来自本机 dim-agent 的现有实现，仅作为接口调查依据；不代表新客户端已经获准调用。

| 能力 | 现有接口或行为 |
| --- | --- |
| 元数据 | `GET {issuer}/.well-known/openid-configuration` |
| 浏览器授权 | 元数据中的 authorization endpoint；现有代码默认 `/oauth/authorize` |
| 设备授权 | 元数据中的 device endpoint；现有代码默认 `/oauth/device_authorization` |
| 令牌交换与续期 | 元数据中的 token endpoint；现有代码默认 `/oauth/token` |
| 模型目录 | `GET {issuer}/v1/models?type=dim`，Bearer token |
| 账号用量 | `GET {issuer}/api/me/usage`，Bearer token |
| 重置批次 | `GET {issuer}/api/me/usage-resets`，按订阅与有效期筛选 |
| 执行重置 | `POST {issuer}/api/me/usage-resets/apply`，订阅 ID、重置类型、幂等键 |
| 购买/续期 | `{issuer}/console/subscription`，由官方网页完成交易 |
| 价格 | `{issuer}/console/pricing` |
| 模型请求 | `{issuer}/v1/*`，按模型实际支持协议选择路径 |

插件提供国内和海外两个登录入口。国内默认发行方为 `https://dimagent.cn`，海外为 `https://dimagent.com`；
两者使用独立的 OAuth 客户端配置。没有海外 client ID 时，海外入口显示“海外站（敬请期待）”，
点击仅提示“敬请期待”，不发起授权，也不借用国内客户端配置。
用户介绍和购买链接仅展示国内站；配置说明中的海外信息仅供维护者启用入口时使用。
现有 CLI 的 scope 含远控权限；本插件只请求模型登录与用量所需权限，不直接照搬该 scope。

现有 relay 客户端代码注明 `/v1/*` 检查客户端身份，非预期 User-Agent 可能返回
`403 unsupported client`。需确认服务端允许新插件的客户端身份；不通过冒用现有官方客户端标识绕过。

## 登录与模型请求设计

```text
DimAgent
├─ 国内站登录 → 国内客户端配置 → 国内账号
└─ 海外站
   ├─ 未配置 client ID → 敬请期待
   └─ 已配置 client ID → 独立授权 → 海外账号
```

登录后使用账号记录中的 issuer、token endpoint 和 client ID 查询模型、用量、重置及续期。
账号的宿主 uid 由 issuer 与服务端用户 ID 共同组成，避免两个站点相同的邮箱及用户 ID 被宿主合并。
账户选择器同时显示账号与服务域名，以区分两个站点的账号。已有账号的授权元数据不会随新配置改变。

优先采用 public client 的浏览器授权码与 PKCE S256，校验 state，使用本地 loopback 回调。
具体回调地址与端口必须和新客户端注册一致。若新客户端只开放设备授权，则按服务端登记调整设计，
不同时预设两套登录方式。取消或超时后关闭回调监听；不得记录令牌、授权码或 PKCE verifier。

```text
Magpie login -> Plugin authorize -> Dim authorization page
                                      |
Plugin callback <--- loopback callback-+
  -> Exchange code with PKCE
  -> Return account auth to Magpie
  -> Fetch this account's models
  -> Loader fetch -> Dim /v1/* -> Response stream
```

Magpie 的 `auth.refresh` 从 0.1.684 起支持宿主串行续期，当前版本同时具有跨进程锁。
账户页通过宿主环境中的 `MAGPIE_ADDR` 请求 `POST /v1/magpie/quotas/refresh?provider=dim-oauth`，
由宿主在原生账号作用域下续期并调用 `auth.usage`，不在页面服务中交换或保存 refresh token。
实现以本地验证版本 0.1.2818 为最低声明版本；OpenCode 的基础插件格式兼容不等于完整续期流程兼容，
首版不承诺未经验证的 OpenCode 支持。

Magpie 根据模型的 AI SDK 标记选择协议：`@ai-sdk/openai-compatible` 为 Chat Completions，
`@ai-sdk/openai` 为 Responses，`@ai-sdk/anthropic` 为 Messages。
服务端明确下发的协议决定模型的适配器；未下发协议时遵循 Dim `/v1/models` 的 OpenAI-compatible 默认约定，
不能把缺少 `endpoint_type` 或 `dim: null` 视为模型不可用。不从模型名称推断协议或生成能力。
上下文长度、输出上限、工具调用、图像、推理等级和额度窗口只映射服务端明确信息。
模型目录失败应让宿主保留已有目录；不把故障伪装成账号没有模型。

## 联调与发布

先使用模拟 OAuth/relay 覆盖登录、取消、令牌续期、多账号隔离、目录与用量映射、
流式工具调用、401/429 和请求取消等用户流程。随后在独立 Magpie 配置目录进行真实安装与授权验证，
不改动现有用户的 Magpie 或其他 agent 配置。

已下载并核对官方 Magpie 0.1.2818 CLI 的 SHA-256；通过临时配置目录验证插件安装、模型目录、
用量与令牌续期。浏览器在 `sandbox="allow-scripts"` 的 iframe 下验证账户页、取消、两类重置与窄屏布局。
这些验证使用本地模拟 OAuth 与模型服务，没有进行真实账号授权或真实模型调用。

用户随后提供国内 client ID `271706aab9b74b15a7140b228a419e4a` 和海外 client ID
`91975f99125f42bc88859100a1769ea4`，两者均启用 PKCE。插件已内置各自的新注册，默认回调地址为
`http://127.0.0.1:54322/oauth/callback`，scope 为 `openid profile email`，不再需要用户手动填写。
已访问两站 OIDC 发现端点确认 issuer、授权/令牌/userinfo 地址和 S256 支持；
使用各自的新 client ID 发起匿名授权预检，均返回 302 到本站 `/oauth-login`。
没有执行真实登录、真实模型请求或消费重置次数。

当前按用户要求推送到 `arcships/magpie-dim-oauth` 私有仓库；使用 GitHub 安装需要对应私有仓库权限。
暂不发布 npm。后续公开后可用 `magpie plugin add arcships/magpie-dim-oauth` 安装；
进入 Magpie 推荐目录需要单独提交社区 `registry.json` 条目，
创建 GitHub 仓库不会自动进入推荐目录。

## 真实服务联调前待补信息

- 真实登录后确认 refresh token 签发、userinfo 与令牌续期。
- relay 接受的新插件请求标识，以及该客户端对模型、用量 API 的访问权限。

## 消融检查

已移除实现过程中临时加入的插件侧刷新缓存与调度，统一交给 Magpie 的原生跨进程续期。
账户页服务是必要结构：Magpie 的普通静态插件页面不能联网或读取账号，无法直接承载用量与额度重置。
窗口的来源字段用于重置后更新订阅用量并保留独立功能额度，避免依赖展示名称判断业务类型。
不新增协议转换、网关、持久化凭据或通用 RPC 框架。
企业发现、多地区自动切换、远控、推荐返利和公告暂不纳入本次用户确认的账户流程。
地区选择直接使用 Magpie 的两个原生登录方法，不增加全局地区状态或额外选择页。

## 图标与使用文档

图标原样复制自 dim-agent 仓库的 `packages/desktop/build/icon.png`，保存为 `page/icon.png`。
`magpie.icon` 内嵌相同 PNG 的 data URI，让私有仓库安装后的插件卡片也能显示图标；
侧栏、账户页与 README 使用打包在插件中的原图。不另做图标变体或增加运行时图片转换。
README 面向用户介绍安装、登录、选择模型、查看用量、重置额度和购买续期；
维护者配置移到 `setup.md`，后续公开与上架操作记录在 `distribution.md`，暂不执行。

## 桌面页面与真实目录修复验证

2026-11-03 在本机 Magpie 桌面版复现账户页空白。浏览器版可显示，但桌面窗口来源是
`wails://localhost`；WebKit 日志明确记录账户页主资源因 CSP `frame-ancestors` 被中断。
账户页仅在原有受信任嵌入来源中补充 `wails://localhost`，重新加载插件与桌面页面后，
实际显示登录账号、套餐、用量和重置次数。保留原有 Host、Origin、会话令牌和网络来源限制。

同一账号实际 `/v1/models?type=dim` 返回 33 条记录，只有两个 Claude 显式声明 `endpoint_type`。
原先的筛选误把其余条目当成不支持的协议；现改为未声明时使用 OpenAI-compatible 默认协议，
保留服务端明确声明的模型能力。回归流程覆盖有 dim 无 endpoint、`dim: null` 和图片输出声明。
不把真实账号的 token 或完整业务响应提交到仓库。

ZDR 仅由目录条目顶层 `zdr === true` 决定；`zdr_supported` 不代表当前账号已获得零留存承诺。
Magpie 当前插件宿主不透传独立 ZDR 徽章字段，因此在模型显示名末尾标注 `· ZDR`，保持模型 ID、
`api.id` 和请求协议不变。每次刷新重新根据服务端标志生成显示名，缺失或关闭时不保留旧标记。

## 账户页视觉整理

账户页使用与 Magpie 一致的中性灰及 Dim Desktop 的品牌绿色操作强调色，保留浅色与深色主题。
套餐信息与购买、续期入口集中在顶部；原始购买链接收进原生 details，仍可展开复制。
用量按可用宽度排列，窄屏单列；剩余额度使用结构化 amount/unit 展示，避免解析显示字符串。
倒计时超过一天时按天与小时展示，精确时间保留在提示中。重置仍保留原有二次确认与幂等流程。
本机原生 Magpie 验证真实账户显示、链接展开与刷新。消融检查去除了重复品牌标题和常驻长链接，
未增加界面依赖、额外接口或持久化状态。

账户剩余额度合并到月度额度卡片，直接展示服务端账户汇总，避免与套餐余额重复列卡。
汇总可能包含额外额度，因此文案明确为“账户剩余”，不推算或冒充套餐剩余；无套餐时仍单独展示。

插件展示名称、侧栏标题及账户页标题统一为 `DimAgent`；包名、服务商 ID `dim-oauth`、
仓库地址与授权注册保持不变，已有账号不需要重新登录。

强调色与 Dim Desktop `global.css` 的 brand-green/brand-cta-ink 一致：浅色 `oklch(0.6000 0.1380 150)`，
深色 `oklch(0.7600 0.1500 149)`，深色按钮文字使用 `oklch(0.1100 0.0240 150)`。
