<div align="center">
  <img src="static/assets/logo.png" alt="AI Image Studio · 拾光" width="420">
  <h1>AI Image Studio · 拾光</h1>
  <p><b>为你量身打造的本地优先 · 个人 AI 生图工作台与灵感画廊</b><br>聚合各路 API Key · 多模型调度 · 一条提示词多张出图 · 元数据追溯 · 零 GPU / Node 依赖</p>
  <p>
    <a href="https://github.com/lmz-666-lmz/ai-image-studio"><img src="https://img.shields.io/badge/GitHub-Repo-181717.svg?logo=github" alt="GitHub"></a>
    <img src="https://img.shields.io/badge/Version-v1.2.0-e2ad62.svg" alt="v1.2.0">
    <img src="https://img.shields.io/badge/License-MIT-2ea44f.svg" alt="MIT">
    <img src="https://img.shields.io/badge/Python-3.10+-3776ab.svg?logo=python" alt="Python 3.10+">
    <img src="https://img.shields.io/badge/GPU-Not%20Required-8e7cc3.svg" alt="No GPU required">
  </p>
  <p><b>中文</b> · <a href="README_EN.md">English</a> ｜ 作者 / Author: <a href="https://github.com/lmz-666-lmz">lmz-666-lmz</a></p>

  <img src="screenshots/wall-darkroom.png" alt="拾光主界面 · 暮金主题" width="100%">
<sub>暮金 darkroom · 瀑布流历史墙 · 三步式生图面板 · 收藏与批量管理</sub>
</div>

---

## ✨ 拾光是什么

拾光是**为你量身打造的本地优先 · 个人 AI 生图工作台与灵感画廊**：聚合各路 API Key，实现多模型调度、一条提示词多张出图与元数据追溯；纯 Python + 原生前端架构，零 GPU 与 Node 依赖，一行命令打造私人专属创作空间——笔记本、NAS 或树莓派都能跑。

### 解决的痛点

| 你的痛点 | 拾光的做法 |
|---|---|
| 中转站好几个，Key 散落各处，哪家能用全凭运气 | N 个中转站聚合在一个窗口，健康检测一目了然，线路故障安全切换备用站 |
| 好图散落在平台网页里，prompt 找不到、参数复现不了 | 本地图库，每张图带同名 JSON 追溯（prompt / 模型 / 尺寸 / 耗时 / 线路），可收藏、批量管理、一键导出 |
| 想用 API 生图，但重型工具要 GPU、要装一堆依赖 | 仅 Flask 一个依赖，`python app.py` 即开即用 |
| 想一批想法连试，表单要一次次重复提交 | 一条提示词可选 1-4 张，逐张上屏、进度可见、可随时取消 |
| 担心第三方工具上传密钥和作品 | 只监听 `127.0.0.1`，密钥与图片全程留在本机，设置接口也不向前端返回完整密钥 |

### 亮点

- **极轻**：单文件后端 + 原生 HTML/JS/CSS，三主题画廊质感，旧设备也流畅。
- **聚合**：多中转站统一管理；模型能力自动适配（画幅 / 质量 / 背景 / 风格 / 参考图按模型族动态显示）。
- **可追溯**：画廊即档案，任何一张旧图都能找回当时的完整参数。
- **好用**：暗房显影动画、灯箱缩放平移、最多 4 张参考图生图、收藏与筛选、元数据导出。

## 🖼 界面一览

<div align="center">
<table>
  <tr>
    <td width="50%" align="center"><img src="screenshots/wall-ink.png" alt="黛夜主题"><br><sub><b>黛夜</b> · ink</sub></td>
    <td width="50%" align="center"><img src="screenshots/wall-paper.png" alt="宣纸主题"><br><sub><b>宣纸</b> · paper</sub></td>
  </tr>
  <tr>
    <td width="33%" align="center"><img src="screenshots/settings-providers.png" alt="中转站设置"><br><sub><b>中转站设置</b><br>多站管理 · 健康检测</sub></td>
    <td width="33%" align="center"><img src="screenshots/generating.png" alt="显影动画"><br><sub><b>显影动画</b><br>红光扫过 · 实时计时</sub></td>
    <td width="33%" align="center"><img src="screenshots/lightbox-info.png" alt="灯箱"><br><sub><b>灯箱</b><br>缩放平移 · 参数追溯 · 收藏</sub></td>
  </tr>
</table>
</div>

## 🚀 快速开始

```bash
git clone https://github.com/lmz-666-lmz/ai-image-studio.git
cd ai-image-studio
pip install -r requirements.txt   # 仅 Flask 一个依赖
python app.py                     # 自动打开 http://127.0.0.1:7860
```

首次使用点右上角 ⚙ 设置 → 「＋ 添加新的中转站」→ 填地址和密钥 → 测试连接 → 保存，即可生图。

基本流程：

1. 选择或手填模型，拾光自动识别模型能力并显示对应参数。
2. 输入 Prompt：**你写的整段文字就是这一张图的提示词**，写几段都不会被拆开；想出多张用「数量」选 1-4。
3. 需要图生图时点「＋ 参考图」，选择 / 拖入 / 粘贴最多 4 张 PNG / JPEG / WEBP。
4. 「开始生成」或 `Ctrl + Enter`。结果自动保存到 `outputs/` 并进入历史墙。

## ⚙️ 配置详解

### 方式一：页面配置（推荐）

设置页里添加 / 编辑 / 切换中转站，点击主题即换，所有改动自动写入本地 `config.json`。**设置接口不会把完整 API Key 返回给浏览器**；编辑时密钥留空表示保持原值。

### 方式二：文件配置

复制 `config.example.json` 为 `config.json` 再填写（升级不会删除旧字段、旧中转站或历史）：

```json
{
  "name": "拾光",
  "theme": "darkroom",
  "failover_enabled": false,
  "providers": [
    {
      "id": "provider_1",
      "name": "官方中转",
      "api_base": "https://example.com",
      "api_key": "sk-…",
      "models": ["gpt-image-1"]
    },
    {
      "id": "provider_2",
      "name": "备用线路",
      "api_base": "https://example.org/v1",
      "api_key": "sk-…",
      "models": []
    }
  ],
  "active_provider": "provider_1"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 应用名称，显示在左上角 |
| `theme` | string | `darkroom` 暮金 / `ink` 黛夜 / `paper` 宣纸 |
| `failover_enabled` | bool | 备用线路开关，默认关闭 |
| `providers[]` | array | 中转站列表，可任意多个 |
| `providers[].id` | string | 唯一 id，缺省自动生成 |
| `providers[].name` | string | 显示名称 |
| `providers[].api_base` | string | API 地址，**可带或不带 `/v1`**，拾光自动兼容 |
| `providers[].api_key` | string | 密钥，仅存本机，勿提交到仓库 |
| `providers[].models` | array | 模型缓存，首次使用后自动拉取填充 |
| `active_provider` | string | 当前使用中的中转站 id |

### 支持的平台

凡是实现 OpenAI 兼容 `/v1/images/generations`（图生图另需 `/v1/images/edits`）的服务都能接入：

| 平台 / 形态 | `api_base` 示例 | 说明 |
|---|---|---|
| OpenAI 官方 | `https://api.openai.com` | `gpt-image` / `dall-e` 族，参数自动对齐官方约束 |
| new-api / one-api 系中转 | `https://your.relay` | 最常见形态，地址带不带 `/v1` 均可 |
| SiliconFlow 等模型平台 | `https://api.siliconflow.cn` | `flux` 等生图模型 |
| 自建 / 其他兼容站 | 任意 | 未知模型名自动进入 **Generic OpenAI Compatible** 通用模式，不做白名单拦截 |

模型族识别覆盖 `gpt-image`、`dall-e`、`nano-banana / banana`、`gemini image`、`seedream`、`flux`、`grok image` 等关键词，中转站改名（连字符 / 下划线 / 大小写）也能适配。

### 运行时文件

- `outputs/`：生成图片 + 同名 `.json` 元数据（prompt / 模型 / 尺寸 / 耗时 / 线路 / 收藏）。
- `runtime_state.json`：健康检测等运行时状态，自动创建、可安全删除重建。
- 三者与 `config.json` 均已加入 `.gitignore`。

## 🎛 v1.2.0 功能清单

| 功能 | 说明 |
|---|---|
| **模型能力自动适配** | 按模型族动态显示画幅、质量、背景、风格、数量和参考图入口；发送前过滤不支持的字段，避免上游 400。侧栏「本次将发送」实时列出真正会发出去的参数。 |
| **数量真实生效** | 官方 `gpt-image` / `gemini image` / `grok image` 一次只返回 1 张，选择多张时自动分次补齐；支持一次多图的模型（`dall-e` / `seedream` / `flux`）先整批请求，返回不足再补齐。张数不足会如实提示，补齐中途失败也保留已出的图。 |
| **多参考图 / 图生图** | 最多 4 张 PNG / JPEG / WEBP；单张用 `image` 字段，多张按官方约定用 `image[]`。 |
| **整段提示词 = 一张图** | 输入框里的全部文字（含多段、换行）原样作为一条提示词发给模型，不按行、不按空行拆分；想多出几张用「数量」。进度实时上屏、出图即进墙，取消在下一个上游请求前生效，不打断已发出的请求。 |
| **14 种画幅比例** | 1:1 / 5:4 / 4:3 / 3:2 / 16:9 / 2:1 / 21:9 / 3:1 / 4:5 / 3:4 / 2:3 / 9:16 / 1:2 / 9:21，按「方 / 横 / 竖 / 宽幅 / 长幅」分类切换，每格画出真实比例并标注像素尺寸；官方尺寸带实心角标。自定义宽高照旧原样透传。 |
| **画幅被拒自动回退** | 中转站只认官方尺寸时（返回 400/422），自动改用该模型族的官方画幅重试一次，不让一次尝试白费；元数据同时记录「你要的尺寸」与「实际用的尺寸」。 |
| **参数可追溯可复用** | 质量 / 背景 / 风格 / 画幅 / 数量 / 参考图全部写进同名 JSON；灯箱里显示并支持「复用全部参数」，一键把整张图的设置搬回面板。 |
| **收藏与批量管理** | 星标收藏、只看收藏筛选、灯箱收藏切换；批量勾选删除；元数据一键导出 JSON 备份。 |
| **中转站健康检测** | 异步探测 `/v1/models`（不产生付费生图），显示正常 / 较慢 / 限流 / 不可用与延迟，缓存 45 秒，多站并行探测互不等待；生成耗时不再混进健康延迟。 |
| **上游报错直译** | 生成失败时附上中转站返回的具体原因（`error.message` 等关键信息），不再只有一串 HTTP 状态码，排障不用再猜。 |
| **安全故障切换** | 仅 401 / 403 / 404 / 429 / 502 / 503 / 504 或明确连接失败时切换一次同模型备用站；不确定超时不重试；补齐轮不再切换，避免同组图片风格跳变。 |
| **本地历史与三套主题** | 瀑布流、筛选、分页、灯箱、显影动画；内存索引支撑上千张图片不卡顿。 |

<details><summary><b>v1.2.0 相比 v1.1.0 的改进</b></summary>

- **修掉 grok 模型族识别失效**：真实模型名 `grok-2-image` 归一化后是 "grok 2 image"，旧匹配词 "grok image" 永远匹配不上，导致它被当成通用模型照发 `size`、官方 xAI 接口直接 400；现在按 "grok" 关键词正确归族，画幅字段整个不发。
- **画幅字段按能力过滤**：`size_mode = none` 的模型族前后端都不再携带残留的画幅值，与界面「该模型族不接收画幅」的提示真正一致。
- **上游报错带原因**：401/429/400 等错误信息后附加中转站 JSON 里的具体原因（截取前 160 字符），「额度不足」「模型不存在」一眼可见。
- **健康检测并行**：多站探测由串行改为并行，一站超时不再拖住全部结果；前端改为一次请求探测全部线路。
- **证书警告不再丢失**：HTTPS 证书降级提示现在贯穿同步生成、任务队列与失败响应，都会以 Toast 透出。
- **模型发现更全**：`/v1/models` 过滤关键词补充 stable-diffusion / sd / cogview / wan / kolors / janus / ideogram / recraft 等常见生图模型族。
- **细节**：参考图缩略图的 objectURL 用完即回收（修复长会话内存泄漏）；`/` 搜索快捷键在灯箱/设置打开时不再劫持按键；收藏筛选按钮不再破坏图标结构。
</details>

<details><summary><b>v1.1.0 相比 v1.0.3 的改进</b></summary>

- **修掉「选了数量还是只出一张」**：数量改为分段按钮并独立成行，后端按模型能力分次补齐到所选张数。
- **参数不再靠猜**：新增「本次将发送」清单，明确列出模型 / 画幅 / 质量 / 背景 / 风格 / 数量 / 模式，以及该模型族不接收哪些字段。
- **健康状态不再误报**：生成耗时不再写成健康延迟（此前出现「正常 42706ms」）。
- **任务更稳**：轮询拿到失效任务会正常收尾；多张出图走队列，可看进度、可取消，取消状态等真正收尾才算完。
- **细节**：默认模型记住上次选择；设置页显示版本与各项上限；空态不再被永久移除；灯箱新增参考图来源。
</details>

## 🖼 参考图与历史元数据

参考图单张不超过 10MB，最多 4 张。已知不支持 edits 的模型会显示轻量提示；未知模型保留通用兼容模式，最终由中转站决定。图生图记录写入同名 `.json`：

```json
{
  "mode": "image-to-image",
  "reference_used": true,
  "reference_name": "reference.png",
  "reference_count": 1
}
```

文生图为 `mode: "text-to-image"`、`reference_used: false`；收藏写入 `"favorite": true`。旧历史缺字段时按文生图 / 未收藏显示，仍可正常浏览。

## 🩺 健康状态与备用线路

状态含义：`正常`（<1.5s）· `较慢`（≥1.5s）· `限流`（429）· `不可用`（连接失败 / 502 / 503 / 504）。

备用线路开启后，主站发生明确线路级故障时，只从缓存模型列表中选一个拥有**相同模型名**的备用站、最多一次备用请求；切换成功后历史元数据记录：

```json
{ "provider_id": "provider_x", "provider_name": "备用线路", "failover": true, "failover_from": "主线路" }
```

## 📁 项目结构

```text
ai-image-studio/
├── app.py              # 单文件后端：API、能力识别、出图队列、健康检测与 failover
├── requirements.txt    # 仅 Flask
├── config.example.json # 配置模板
├── README_EN.md        # English documentation
├── static/index.html   # 页面结构
├── static/style.css    # 三主题画廊质感样式
├── static/app.js       # 生成、数量补齐、参考图、历史墙、收藏、灯箱与 GSAP 动效
├── screenshots/        # README 预览图
└── outputs/            # 本地生成图片与同名 JSON（运行时创建）
```

## ❓ 常见问题

<details><summary><b>我的 API Key 和图片会上传到别处吗？</b></summary>

不会。拾光只监听 `127.0.0.1`，密钥存在本地 `config.json`，图片存在本地 `outputs/`；请求只发往你配置的中转站。设置接口也不向前端返回完整密钥。
</details>

<details><summary><b>为什么某个模型没有质量 / 背景参数？</b></summary>

拾光按模型能力动态显示参数，并在发送前过滤不支持的字段，避免上游 400。未知模型使用 Generic 通用模式。
</details>

<details><summary><b>为什么图生图按钮不可用？</b></summary>

已知模型未声明 `image_to_image` 能力时会提示；可切换支持 edits 的模型。未知模型不会被武断禁止，最终由中转站决定。
</details>

<details><summary><b>为什么生成失败没有自动换站？</b></summary>

备用线路默认关闭，且只对明确线路故障切换一次；400 / 401 / 403 和不确定超时不重试，避免重复生成与重复计费。备用站还必须缓存有相同模型。
</details>

<details><summary><b>健康检测会扣费吗？</b></summary>

不会。只调用 `/v1/models`，缓存 45 秒。
</details>

<details><summary><b>升级后原来的配置和历史还在吗？</b></summary>

在。旧版单站 `api_base` / `api_key` 自动迁移为 providers，旧图片和旧 JSON 继续可读，新字段提供默认值。
</details>

---

MIT License · AI Image Studio · 拾光 · v1.2.0
