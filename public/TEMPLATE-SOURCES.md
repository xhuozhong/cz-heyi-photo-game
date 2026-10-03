# 合影模板素材说明

更新日期：2026-10-03。所有人物模板均由用户提供的两张参考图进行本地裁切、抠除背景和调色得到，没有为模板调用 AI 生图服务。原始文件保持不变。

## 文件与坐标

素材位于游戏的 `public/assets/templates/`，入口为 `manifest.json`。人物和身体 PNG 均为 384 × 1152、RGBA、透明背景。路径字段以 `public/` 为根，例如 `assets/templates/cz.png`。

| 素材 | 内容 |
|---|---|
| `cz.png`、`heyi.png` | 单一正面伙伴人物，保留原头像和服装 |
| `male-body.png`、`female-body.png` | 移除原头、保留颈部和肩部的身体 |
| `*-body-black.png`、`*-body-cream.png`、`*-body-red.png` | 黑、米白、红三种服装变体 |
| `*-clothing-mask.png` | 白色、按透明度标示的衣服调色区域 |
| `*-skin-mask.png` | 颈部和手臂皮肤区域，含男性手臂纹身的完整皮肤表面 |
| `*-head-erase-mask.png` | 实际从原人物中移除的头发、脸部区域 |

`face` 是额头至下巴、左右脸颊的脸部目标框，不是整头发范围。坐标全部使用 PNG 像素。

| 身体 | face（x, y, width, height） | neck（x, y） | 原颈部 RGB 样本 |
|---|---|---|---|
| 男性 | 135, 72, 123, 134 | 196, 243 | 194, 153, 131 |
| 女性 | 131, 42, 120, 144 | 202, 225 | 212, 173, 142 |

`fullHead` 提供原头发整体范围；`headErase` 是实际移除像素的包围框。女性长发移除范围会经过肩部，不能把这个包围矩形整体清空：身体 PNG 已经移头，精确范围应以 `headEraseMask` 为准。`torso` 提供躯干调整的上下界；肩部和头部应使用独立的变形控制。

## 已完成的处理与检查

去除灰白背景，包括手臂围成的封闭空隙。轮廓做了约一个源像素的收缩、边缘颜色去污染及透明度过渡。颈部明亮皮肤被单独保护，已修复把亮色反光误删为背景导致的领口透明孔。男性整片衣领纳入服装调色，同时保护皮肤和纹身；女性调色以红衣布料色相为依据，避免染到手臂和手。

已查看所有素材的深色背景拼图、放大的男性衣领和服装蒙版，以及咖啡馆实景中的透明边缘。服装变体另以皮肤蒙版恢复原肤色，保留皮肤纹理。样例头像 `public/assets/sample-player.jpg` 从已有样例文件转换，为 1024 × 768 的 JPEG。

原始正面人物面积较小，放大后不会增加真实细节。女性原长发覆盖肩侧，移除后极细小的肩部轮廓仍可能需要头像覆盖或局部微调。用正脸、光线均匀的玩家头像更容易与身体衔接。

## 场景照片出处

三张授权摄影背景已保存为普通 JPEG；显示时可按合影画框裁切。图库照片适用 [Unsplash 许可](https://unsplash.com/license)，可下载、修改和用于网页。保留以下出处以便后续核对与署名。

| 文件 | 尺寸 | 出处 |
|---|---|---|
| `public/assets/scenes/terrace.jpg` | 1600 × 2133 | [Kellen Riggin / 7P-7Xru81Yg](https://unsplash.com/photos/7P-7Xru81Yg) |
| `public/assets/scenes/cafe.jpg` | 1600 × 925 | [Sidney Smith / ucZv4gn94VE](https://unsplash.com/photos/ucZv4gn94VE) |
| `public/assets/scenes/street.jpg` | 1600 × 2133 | [Allen Boguslavsky / Lr50LGoEIIY](https://unsplash.com/photos/an-empty-city-street-in-the-middle-of-the-day-Lr50LGoEIIY) |

场景素材按照主任务提供的图片地址下载，用于本地网页开发，不依赖打开网页后再加载外部图片。
