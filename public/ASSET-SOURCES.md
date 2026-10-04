# 本地免费人像处理依赖

这些资源只在浏览器执行人像分割与人脸定位，不调用图片生成接口，不使用 LibTV / ChatGPT / Hugging Face 额度。

## 来源与许可

- 官方 [MediaPipe Tasks Vision 网页指南](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter/web_js) 推荐使用 `@mediapipe/tasks-vision` npm 包。2026-10-03 核查 npm registry stable latest 为 **1.0.1**；本项目锁定此版本，不使用 nightly。运行资产经文档推荐的 jsDelivr npm CDN 获取并验证 CDN SHA-256 文件清单。
- JavaScript / WebAssembly：Apache-2.0；许可证存放在 `public/vendor/mediapipe/LICENSE`。
- [Selfie Segmentation 官方模型卡](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf) 和 [BlazeFace Short Range 官方模型卡](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf) 均明确模型为 Apache License 2.0。
- 两模型使用固定版本 `/float16/1/`，避免 `latest` 的内容漂移。
- 下载日期：2026-10-03（Asia/Shanghai）。所有内容保存在本地网页目录，玩家运行时无需访问 CDN。

## 文件清单

| 文件（public/vendor/mediapipe/ 下） | 字节 | SHA-256 | 下载地址 |
|---|---:|---|---|
| vision_bundle.mjs | 155439 | d885630c297c0b20b1fe86096cb06291c4c8080876f27852e724f24ac603713f | [来源](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs) |
| wasm/vision_wasm_internal.js | 323377 | e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73 | [来源](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/vision_wasm_internal.js) |
| wasm/vision_wasm_internal.wasm | 11756954 | 8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886 | [来源](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/vision_wasm_internal.wasm) |
| wasm/vision_wasm_module_internal.js | 323415 | da8934057f147b622e82cfb4c0dbd85461c598e268588b5a8ba9ca963a8ff82d | [来源](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/vision_wasm_module_internal.js) |
| wasm/vision_wasm_module_internal.wasm | 11756972 | 2dabd8e23c60984628beb7bb338764c81a08e6837145273f59578684b5d53c1b | [来源](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/vision_wasm_module_internal.wasm) |
| wasm/vision_wasm_nosimd_internal.js | 323180 | e81d715a3d42cc3373602eb2f7aff795d164934db680e32496b65dab537f9658 | [来源](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/vision_wasm_nosimd_internal.js) |
| wasm/vision_wasm_nosimd_internal.wasm | 10960242 | a28483cd42e74e855bf5ebdb6b40d9b66a5b49e35e95020bc97669e6822a3192 | [来源](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/vision_wasm_nosimd_internal.wasm) |
| selfie_segmenter.tflite | 249537 | 191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b | [来源](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite) |
| blaze_face_short_range.tflite | 229746 | b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f | [来源](https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite) |
| LICENSE | 12331 | 8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8 | [来源](https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE) |

## 应用边界

SelfieSegmenter 面向近距离、主体清晰的人像；多个人、远景、细发丝、手指及遮挡可能产生边缘误差。FaceDetector 只定位脸部框与六个关键点，不识别身份。玩家头像合成仅使用上传照片像素、透明蒙版和预制场景模板；当前伙伴人物是根据用户参考图预先生成的连贯人物素材，见 [模板素材说明](TEMPLATE-SOURCES.md)。玩家运行免费模式时不调用图片生成服务，真实性取决于照片角度、光线和模板匹配。

## 浏览器实测（2026-10-03）

在本机 Google Chrome 无头模式使用 CPU delegate，加载的 JavaScript、WASM 与模型均来自上述本地目录。输入为项目的虚构玩家样例和用户提供 CZ 参考图中的近照裁剪；没有图片生成调用。

- 两张输入均成功运行分割及人脸定位；虚构玩家检测置信度 0.9837585，CZ 近照检测置信度 0.9166586。
- **此锁定 square 模型返回 1 张 confidenceMasks，`getLabels()` 为 `["selfie"]`。前景取 `confidenceMasks[0].getAsFloat32Array()`，值 0～1，1 为人物。** 实测脸部中心=1，左上背景约 0。不要误取不存在的第 2 张 mask。
- mask 的 `width` / `height` 等于输入图像宽高（1448×1086 / 509×506），不是内部模型 256×256。取数组后及时拷贝所需像素，再 `result.close()`；结束时关闭 detector / segmenter。
- `FaceDetector.detect(image).detections` 为数组；`boundingBox.originX/originY/width/height` 是输入图像中的像素。`keypoints[0]` / `[1]` 是画面左眼 / 右眼，`[2]` 鼻、`[3]` 嘴、`[4]` / `[5]` 耳；x、y 是归一化坐标，分别乘输入宽、高。
- 初始化使用 `FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm")`；两个任务使用 `runningMode: "IMAGE"`，分割配置 `outputConfidenceMasks:true, outputCategoryMask:false`。
- 无未捕获页面异常。测试日志的 404 是未设置 favicon；两条 TensorFlow Lite XNNPACK INFO 被 WASM 打到 error console，属于初始化日志。正式游戏应提供 favicon，并区分 INFO 与实际异常。

静态服务器必须将 `.mjs` / `.js` 以 JavaScript MIME 返回，`.wasm` 以 `application/wasm` 返回。页面可使用相对模型路径，访问域名/子路径部署时随站点调整。模型和运行资产全部保存于项目内，玩家无需使用第三方会员或付费生图服务。
