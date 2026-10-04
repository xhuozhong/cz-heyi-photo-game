# 免费版与付费 AI 合影部署

游戏主入口为 [GitHub Pages](https://xhuozhong.github.io/cz-heyi-photo-game/)，只发布前端与免费合影资源。AI 模式通过 `https://xhuozhong.com` 跨域连接运营方本机服务：付款核验、首次免费记录与首次免费/付费 AI 生成都运行在 Windows 本机，Cloudflare Tunnel 提供 HTTPS API。已启用当前用户登录自启，电脑须保持开机、用户登录与联网；电脑离线时免费模板仍可玩，AI 合影及付款入口会提示暂停。后端示例仍默认不收款且预算为 0。

AI 合影提供 **每个钱包首次免费，之后每次 0.001 BNB**（1,000,000,000,000,000 wei），网络为 **BNB Smart Chain 主网，chainId 56**。收款地址固定为 `0x7C4383da12264BeD66D125EF34d4a4A8Bb8979F2`。首次免费只需钱包签名，不发送链上交易，也没有网络手续费；付费订单的钱包另外支付网络手续费。后端没有钱包私钥，只读核验签名与链上交易。升级前的 0.0001 BNB 或 0.0014 BNB 旧订单沿用订单中记录的金额，新订单使用新价格。

## 服务器准备

### 本次本机与 Tunnel 部署

`https://xhuozhong.com/` 提供 `/api/` 与备用网页，由运营方本机 Node 后端处理。后端仅监听本机回环地址，Cloudflare Tunnel 对外提供 HTTPS。GitHub Pages 前端的 `public/paid-config.js` 指向 `https://xhuozhong.com`；后端的 `FRONTEND_ORIGINS` 须允许 `https://xhuozhong.github.io` 和 `https://xhuozhong.com`，只填写 origin，不含仓库子路径，`SERVICE_DOMAIN` 保持 `xhuozhong.com`。付款签名显示实际 AI 后端服务域名。部署负责人此前已确认该 HTTPS 服务就绪并完成一次真实首次免费 AI 合影。本轮域名新版与真实 Pages origin API 检查已通过，Pages 新版浏览器体验在发布上线后另行验收。

运营方已批准 `LIBTV_GENERATION_BUDGET=100` 的累计总上限。首次免费、后续付费与本轮实际生成共同消耗这 100 次；已经写入 `provider-budget.json` 的生成意图计入上限，包括结果不确定的提交。它不是实时积分余额，也不是每个钱包的额度。源码示例继续默认预算 0，真实值只配置在本机私有环境文件；增加上限须另行获得运营方授权并保留完整历史账本。

登录信息、隧道令牌、环境配置、订单/预算账本、玩家照片与运行日志都只在运营方本机私有目录保存，不进入 GitHub。Cloudflare 官方程序使用令牌文件启动：`cloudflared tunnel --no-autoupdate run --token-file <私有令牌文件绝对路径>`；不要把令牌正文放在命令行、网页或日志中。

本机运维包提供隐藏运行、独占锁、崩溃退避重启以及 `start.ps1` / `stop.ps1` / `status.ps1`，这些 runtime 文件不属于本次公开源码同步内容。当前用户登录任务已启用并实际接管，已增加每分钟异常退出恢复；手动停止会暂停自动恢复，双击启动会重新启用。异常退出恢复和手动暂停均已实际验证，原订单、免费次数记录与生成预算保持不变。可选 `preventSleep:true` 只在监督程序运行期间阻止自动系统睡眠，允许屏幕关闭，不更改全局电源计划。电脑仍须保持开机、用户登录与联网，关机、注销或断网时服务无法持续对外提供。配置变更通过停止并重启同一个监督程序生效，应在正在生成的任务结束后停机。

仓库的 [游戏主入口](https://xhuozhong.github.io/cz-heyi-photo-game/) 仅发布 `public/`，免费合影、微调、签名、下载和相册均在浏览器内完成。AI 模式先跨域核验本机 HTTPS 后端；只有服务、价格和首次免费资格检查通过，并取得照片上传同意后，才可请求钱包签名或付款。本机暂停、断网或不可用时，页面提示 AI 暂停并允许继续免费合影，GitHub Pages 不执行后端程序。

ChatGPT Sites 可托管支持其运行环境的网页和游戏，但官方明确不允许在那里启用金融交易，因此本项目的 BNB 收费服务不能部署到 Sites。依据：[Sites 的限制和不支持用途](https://learn.chatgpt.com/docs/sites?surface=app)。当前 Node/LibTV 后端可运行在持续在线的本机或独立服务器。

使用一台持续在线、有私有持久磁盘的 Windows 或 Linux 服务器。推荐 Node.js 24，并安装 pnpm 11.19.0；依赖由 `pnpm-lock.yaml` 固定。不要使用没有持久存储的临时函数或多个副本。

解压部署包后，在项目根目录执行：

```sh
pnpm install --frozen-lockfile
```

安装 LibTV 官方 CLI。最新安装入口由官方接口 `https://api2.liblib.art/api/www/landing-activities/getById?id=240` 的 `data.linkUrl` JSON 中的 `install.shell` / `install.PowerShell` 下发，应使用实际返回的 URL。不要自行拼版本下载地址。本包没有携带用户 LibTV 凭据，也没有自动安装或复制登录信息。

在运行后端的同一个专用系统用户下，通过官方 `libtv login web` 完成登录，再执行 `libtv account info` 检查账户。新建一个用于付费游戏的画布：

```sh
libtv project create "币安照相馆付费AI订单"
```

将返回的画布 UUID 配入 `.env`。管理员也可提供自己已有的专用画布。每个 AI 订单（包括首次免费）的玩家头像、伙伴参考和生成结果会保存在这个 LibTV 画布；本机未签名上传会自动清理，已授权订单和 LibTV 画布的保留/删除由运营方管理。

## 配置与启动

复制 `.env.example` 为 `.env`，先保持 `PAID_ENABLED=false`。配置以下项：

| 配置 | 用途 |
|---|---|
| `PAID_DATA_DIR` | 绝对路径的私有持久目录，不能位于 `public/` 内 |
| `FRONTEND_ORIGINS` | 允许的前端 HTTPS origin，当前须包含 `https://xhuozhong.github.io` 与 `https://xhuozhong.com`，逗号分隔且不含仓库子路径 |
| `SERVICE_DOMAIN` | 付款签名中显示的真实服务域名 |
| `AI_FIRST_FREE` | 默认 `true`，每个钱包首次 AI 合影免费；如设为 `false`，前端 `paid-config.js` 的 `firstFree` 也须同步为 `false`，已记录的免费次数保留 |
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

默认监听 `127.0.0.1:4176`。本次通过 Cloudflare Tunnel 提供 HTTPS API，GitHub Pages 作为独立静态前端跨域访问。后端须在允许列表内的 origin 请求中返回 CORS 响应，并支持订单上传/授权的预检；私有结果仍须携带订单凭证，不可公开缓存。备用部署可参考 `deploy/Caddyfile.example` 使用 HTTPS 反向代理承载同域网页与 API。不要让浏览器访问 LibTV 登录信息或提供任意服务器命令执行入口。

为避免大型模型每次拍摄都重新经过 Tunnel 下载，后端仅对 `public/vendor/` 和 `public/assets/` 中成功 GET/HEAD 设置 `public, max-age=3600, no-transform`。vendor 的 WASM、TFLite、JS/MJS 在客户端明确接受 gzip（且非 `q=0`）时源端压缩，保留 MIME、`Vary: Accept-Encoding` 与准确长度；HEAD 不发送正文。压缩结果在内存中最多保留 16 MiB/128 个条目，并按源文件修改时间及大小失效，不创建可被下载的缓存目录。HTML、`paid-config.js`、API、错误响应和玩家私有结果继续 `no-store`；图片不会重复 gzip。

Linux 可按 `deploy/cz-heyi-photo-game.service.example` 配置 systemd 常驻服务，替换系统用户、安装目录和 Node 的绝对路径。LibTV 必须在这个服务用户下登录；配置私有数据目录的写入权限。Windows 可使用管理员已有的进程管理工具常驻运行。先检查默认关闭收款的站点，再配置开机启动；关闭 SSH 会话后也应检查服务仍在线。

## 正式开放

部署并检查静态网页、WASM、模型和免费合成可用；保持收款关闭。管理员确认 LibTV 登录、画布、模型、预算与 RPC 就绪后，设置 `PAID_ENABLED=true`，重启同一个后端进程。访问 `/api/health`，只有 `ready:true` 才能开放付款按钮。Health 会立即返回安全快照并在后台预热/刷新：首次核验或超过 60 秒的结果返回 `ready:false, checking:true`，此时允许稍后重试，禁止请求签名、生成或付款。成功结果缓存 20 秒，刷新去重；创建订单、资格查询与授权始终等待新的实际检查，不能用旧缓存绕过不可用状态。

本轮 **63 项自动测试通过**，使用模拟链、CLI 与生成服务，并覆盖静态 gzip、缓存和私有响应隔离，该次自动测试没有发生真实 BNB 转账或 LibTV 生图。部署负责人另已完成一次真实首次免费 AI 合影：截至本次检查，累计 100 次生成预算已使用 1 次、剩余 99 次，未进行真实 BNB 转账。本包不会代替用户签名转账。

此前同域部署的公网页面实际 Chrome 回归 **13 项通过**（免费模板 8 项＋已完成真实 AI 订单只读领取 5 项）。桌面/手机使用 HTTP/2，实际 WASM 压缩传输首次约 4.31/17.50 秒，二次磁盘缓存无网络传输；CZ/何一免费签名、下载与相册正常。真实 AI 原订单的新标签恢复及重复领取得到相同 659,363 字节 JPEG（2048×1785），仅有一层 256 像素的 CZ 签名底栏，原 AI/LibTV 标记保留。这次回归没有钱包调用、POST、重试或新生成，也未见页面/资源错误；只读领取不再次消耗预算。

玩家流程为：选择 AI 合影 → 同意上传头像供服务方与 LibTV 处理 → 连接钱包并查询首次免费资格 → 签名绑定本次订单。首次免费的订单直接进入 LibTV 生成；后续订单在钱包单独确认 0.001 BNB 转账、链上最终确认后生成，完成后可下载或收藏。交易 `data` 中的订单标识必须保留；手动普通转账或相同金额的历史转账不能自动领取本次服务。

免费次数由服务器按规范化的钱包地址记录，并在首次免费订单成功授权时原子占用；同一次授权、重复点击、刷新和重启不会重复发放。尚未授权或已过期的订单不占用免费次数。免费资格按地址计算，不能识别同一人持有多个钱包。免费与付费都消耗管理员批准的 LibTV 生图预算。提交不确定或生成失败时保留原订单并核对已有任务，不自动恢复新的免费资格，避免再次扣额度。

付款前会检查订单有效期，剩余不足 30 秒时停止发起付款；已提交的交易仍保留并继续核验。同一浏览器的其他标签页不能覆盖未完成订单凭证，应先处理原订单。

GitHub Pages 的使用限制不允许以商业交易/SaaS 为主要目的的网站，详见官方使用限制。当前实现把静态游戏与本机 AI 后端分开：前端不包含凭据，API 核验与生成不运行在 GitHub；后端外置本身不改变 GitHub Pages 的使用条款。

## 订单维护

付款与生图提交都持久化记录。生成失败、提交结果不确定、逾期付款等状态会保留付款证明，进入失败或人工处理状态；系统不会要求玩家重新付款，也不会盲目再次消耗生图额度。`retry` 仅查询或找回已有生成。后端没有收款私钥，退款须由运营方核验订单后自行办理。

订单凭证只保存在玩家当前浏览器。玩家需保留订单号与交易哈希，清理浏览器站点数据后应联系运营方找回；跨设备没有账户登录或自动找回功能。输入照片、下载结果、订单账本、预算账本及 CLI 登录配置都不属于公开源码。

备份整个私有数据目录并保持访问权限；不要仅备份图片而丢弃已使用交易哈希、首次免费账本和提交意图。升级会保留旧订单并迁移账本，不应删除或重置免费次数。只运行一个后端进程。反向代理后的 IP 限流由整个代理 IP 共用，流量较大时应在代理增加适合真实流量的限流设置。

## 验证命令与来源

本轮后端 63 项自动检查和新架构本地浏览器 7 项检查通过。当前域名新版实际浏览器 13 项通过（免费模板 8 项＋原已完成 AI 订单只读领取 5 项），真实 Pages origin 的跨域、预检和私有结果 4 项检查通过。整体进程异常退出恢复、手动暂停以及重新启动均保留原订单、免费次数记录与生成预算。GitHub Pages 新版浏览器验收在发布上线后进行，常驻服务的持续观察仍在运行；两者尚未计为已通过，也不再次生成或转账。

安装依赖后执行 `pnpm run test:paid`。测试涵盖签名、链/金额/地址/订单标识、失败交易、最终确认、重复付款兑换、并发请求、私有图片访问、崩溃恢复及 CLI 单次提交；只用测试替身，不转账、不生图。

接口细节见 [API 契约](backend/API-CONTRACT.md)，LibTV 接口见 [Provider 契约](backend/PROVIDER-CONTRACT.md)。

官方依据：[BSC 主网与 RPC](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)、[BSC 最终确认](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/)、[ethers 签名恢复](https://docs.ethers.org/v6/api/hashing/)、[GitHub Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)。
