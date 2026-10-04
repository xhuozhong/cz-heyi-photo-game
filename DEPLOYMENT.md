# 免费版与付费 AI 合影部署

付费模式已开发，但本包默认不收款。用户当前没有服务器；不能把这份部署包当作已上线收费服务。免费版仍可在 GitHub Pages 使用。

单次 AI 合影固定收取 **0.0014 BNB**（1,400,000,000,000,000 wei），网络为 **BNB Smart Chain 主网，chainId 56**。收款地址固定为 `0x7C4383da12264BeD66D125EF34d4a4A8Bb8979F2`。钱包另外支付链上网络手续费。后端没有钱包私钥，只读核验链上交易。

## 服务器准备

使用一台持续在线、有私有持久磁盘的 Windows 或 Linux 服务器。推荐 Node.js 24，并安装 pnpm 11.19.0；依赖由 `pnpm-lock.yaml` 固定。不要使用没有持久存储的临时函数或多个副本。

解压部署包后，在项目根目录执行：

```sh
pnpm install --frozen-lockfile
```

安装 LibTV 官方 CLI。最新安装入口由官方接口 `https://api2.liblib.art/api/www/landing-activities/getById?id=240` 的 `data.linkUrl` JSON 中的 `install.shell` / `install.PowerShell` 下发，应使用实际返回的 URL。不要自行拼版本下载地址。本包没有携带用户 LibTV 凭据，也没有自动安装或复制登录信息。

在运行后端的同一个专用系统用户下，通过官方 `libtv login web` 完成登录，再执行 `libtv account info` 检查账户。新建一个用于付费游戏的画布：

```sh
libtv project create "偶遇照相馆付费AI订单"
```

将返回的画布 UUID 配入 `.env`。管理员也可提供自己已有的专用画布。每个付费订单的玩家头像、伙伴参考和生成结果会保存在这个 LibTV 画布；本机未签名上传会自动清理，已付款订单和 LibTV 画布的保留/删除由运营方管理。

## 配置与启动

复制 `.env.example` 为 `.env`，先保持 `PAID_ENABLED=false`。配置以下项：

| 配置 | 用途 |
|---|---|
| `PAID_DATA_DIR` | 绝对路径的私有持久目录，不能位于 `public/` 内 |
| `FRONTEND_ORIGINS` | 实际付费站的 HTTPS origin，例如 `https://paid.example.com` |
| `SERVICE_DOMAIN` | 付款签名中显示的真实服务域名 |
| `BSC_RPC_URL` | 支持主网 `finalized` 区块标签的 HTTPS RPC |
| `LIBTV_CLI` | 官方 CLI 可执行文件路径，空值使用当前系统用户的默认安装位置 |
| `LIBTV_PROJECT_UUID` | 专用订单画布 UUID |
| `LIBTV_ACCOUNT_ID` | 已核对的 LibTV 账户 ID，防止当前账户切换后误用额度 |
| `LIBTV_GENERATION_BUDGET` | 管理员批准的生图次数总上限，默认 0 |

LibTV CLI 1.1.3 不提供实时剩余积分余额。管理员须先在 LibTV 核对额度与所选模型成本，再批准可用次数；不能把“会员有效”当作“积分充足”。私有 `provider-budget.json` 记录所有已开始的生成意图，包括结果不确定的提交。增加预算时填写“已记录的 started 数量 + 新批准次数”，不要删除或重置这个账本。服务器只允许一个预约收款/生成订单同时占用容量；管理员也应避免其他地方同时消耗为游戏保留的额度。

Windows 运行 `deploy/start-paid.ps1`；Linux 运行：

```sh
sh deploy/start-paid.sh
```

也可直接运行 `node --env-file=.env backend/server.mjs`。`.env` 只有通过这些启动入口或显式传入环境时才会加载。

默认监听 `127.0.0.1:4176`。用 HTTPS 反向代理向外提供整个网站和 API，参考 `deploy/Caddyfile.example`。根路径同时承载免费版和付费版，网页使用同域 API。不要让浏览器访问 LibTV 登录信息或提供任意服务器命令执行入口。

Linux 可按 `deploy/cz-heyi-photo-game.service.example` 配置 systemd 常驻服务，替换系统用户、安装目录和 Node 的绝对路径。LibTV 必须在这个服务用户下登录；配置私有数据目录的写入权限。Windows 可使用管理员已有的进程管理工具常驻运行。先检查默认关闭收款的站点，再配置开机启动；关闭 SSH 会话后也应检查服务仍在线。

## 正式开放

部署并检查静态网页、WASM、模型和免费合成可用；保持收款关闭。管理员确认 LibTV 登录、画布、模型、预算与 RPC 就绪后，设置 `PAID_ENABLED=true`，重启同一个后端进程。访问 `/api/health`，只有 `ready:true` 才能开放付款按钮。

开发验证使用了模拟链和模拟生成服务；没有发生真实 BNB 转账，也没有运行收费 LibTV 生图。正式营业前仍需由运营方自愿完成一笔真实钱包付款与实际出图验收，检查费用、画面质量和服务响应。本包不会代替用户签名转账。

玩家流程为：选择 AI 合影 → 同意上传头像供服务方与 LibTV 处理 → 连接钱包 → 签名绑定本次订单 → 钱包单独确认 0.0014 BNB 转账 → 链上最终确认 → LibTV 生成 → 下载或收藏。交易 `data` 中的订单标识必须保留；手动普通转账或相同金额的历史转账不能自动领取本次服务。

付款前会检查订单有效期，剩余不足 30 秒时停止发起付款；已提交的交易仍保留并继续核验。同一浏览器的其他标签页不能覆盖未完成订单凭证，应先处理原订单。

GitHub Pages 的使用限制不允许以商业交易/SaaS 为主要目的的网站。`*.github.io` 上已硬性关闭所有付款调用，即使误填后端配置也无法收款。免费版可继续放在 Pages，正式付费站应部署在自己的服务器；之后可在免费版 `public/paid-config.js` 的 `paidSiteUrl` 配置付费站链接。

## 订单维护

付款与生图提交都持久化记录。生成失败、提交结果不确定、逾期付款等状态会保留付款证明，进入失败或人工处理状态；系统不会要求玩家重新付款，也不会盲目再次消耗生图额度。`retry` 仅查询或找回已有生成。后端没有收款私钥，退款须由运营方核验订单后自行办理。

订单凭证只保存在玩家当前浏览器。玩家需保留订单号与交易哈希，清理浏览器站点数据后应联系运营方找回；跨设备没有账户登录或自动找回功能。输入照片、下载结果、订单账本、预算账本及 CLI 登录配置都不属于公开源码。

备份整个私有数据目录并保持访问权限；不要仅备份图片而丢弃已使用交易哈希和提交意图。只运行一个后端进程。反向代理后的 IP 限流由整个代理 IP 共用，流量较大时应在代理增加适合真实流量的限流设置。

## 验证命令与来源

安装依赖后执行 `pnpm run test:paid`。测试涵盖签名、链/金额/地址/订单标识、失败交易、最终确认、重复付款兑换、并发请求、私有图片访问、崩溃恢复及 CLI 单次提交；只用测试替身，不转账、不生图。

接口细节见 [API 契约](backend/API-CONTRACT.md)，LibTV 接口见 [Provider 契约](backend/PROVIDER-CONTRACT.md)。

官方依据：[BSC 主网与 RPC](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)、[BSC 最终确认](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/)、[ethers 签名恢复](https://docs.ethers.org/v6/api/hashing/)、[GitHub Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)。
