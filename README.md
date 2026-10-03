# 偶遇照相馆 · CZ & 何一

[在线试玩](https://xhuozhong.github.io/cz-heyi-photo-game/)

玩家上传正面头像，选择 CZ 或何一作为合影伙伴，再选择男女身体模板、三种身材版型、三种衣服颜色及天台、咖啡馆、街头场景，制作 1024×768 的模板合影。支持头像大小、位置和明暗微调、手动圈选、JPEG 下载和浏览器本地相册。

## 费用与照片

游戏使用浏览器内的 MediaPipe 人脸定位与人物分割，再用 Canvas 拼合原照片像素和模板。玩家头像不上传，不调用图片生成服务，不消耗 LibTV 或 ChatGPT 生图额度，无需 API 密钥或共享账号。

相册仅保存在当前浏览器，最多12张；下载图片带“合成合影”标记，不代表真实见面。

## 本机运行

需要 Node.js 20 或更新版本，无需安装第三方 npm 依赖。

运行 `npm start`，打开 <http://127.0.0.1:4175>；Windows 也可以双击 `start-game.cmd`。`PUBLIC_PORT` 可修改端口。

默认静态服务只监听本机，支持 GET/HEAD，没有账号、上传或生成 API。要部署在线游戏，发布 public 目录中的全部文件即可；托管服务需支持 .mjs、.wasm 和 .tflite 静态文件。

## GitHub Pages 发布

公开仓库使用 GitHub Pages 托管。仓库 Settings → Pages → Source 选择 GitHub Actions。`.github/workflows/pages.yml` 将 `public/` 作为完整静态网站发布；修改游戏后推送到 `main` 会自动更新在线版本，也可在 Actions 手动运行。

所有游戏资源使用相对路径，可从 `/cz-heyi-photo-game/` 项目子路径加载，无需外部生图服务或部署密钥。

## 文件

- public/index.html、styles.css、app.js：交互界面、设置、合影和相册。
- public/template-compositor.js：头像分割、对齐、调光、身体肤色匹配与模板合成。
- public/assets：人物参考、身体/衣服/皮肤蒙版、实拍场景与虚构示例头像。
- public/vendor/mediapipe：固定版本1.0.1的运行库、模型、WASM、LICENSE和校验清单。
- static-server.mjs：本机静态入口。

本仓不包含历史云端研究后端、账号配置、生成任务、日志或玩家上传照片。

## 效果范围与来源

当前男款提供 T 恤、女款提供无袖连衣裙，各有黑、米白、酒红三种颜色；身材选择调整身体宽度，保留头部比例。CZ 和何一的伙伴模板使用参考表中的脸部特写改善五官细节，身体仍使用原全身参考。正面、清晰、背景简单的玩家头像更自然；侧脸、遮挡和复杂发丝可能留下合成边缘，不能保证任意头像都呈现真实摄影效果。

人物与场景来源见 [模板素材说明](public/TEMPLATE-SOURCES.md)，运行库与模型来源见 [开源处理工具说明](public/ASSET-SOURCES.md)。许可证适用范围见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 验证

既有版本在实际 Chrome 浏览器通过头像上传、合成、设置、微调、下载、相册刷新和手机布局回归，以及服装皮肤保护检查。2026-10-03 已验证 GitHub Pages 的项目子路径可加载本地 JS、WASM 和模型并完成合影；该次验证未出现资源失败、未捕获异常或照片 POST。
