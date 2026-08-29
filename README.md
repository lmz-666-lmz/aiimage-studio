<div align="center">
  <img src="static/assets/logo.png" alt="Image Studio · 拾光" width="420">
  <h1>Image Studio · 拾光</h1>
  <p><b>v1.0.3 · 本地优先的 OpenAI 兼容生图工作台</b></p>
  <p>作者 / Author: <a href="https://github.com/lmz-666-lmz">lmz-666-lmz</a></p>
  <p><code>Python</code> · <code>Flask</code> · <code>原生 HTML / JS / CSS</code> · <code>GSAP</code> · <code>无 Node.js 构建依赖</code></p>
  <p><a href="https://github.com/lmz-666-lmz/image-studio">GitHub</a> · <a href="#-快速开始">快速开始</a> · <a href="#-v103-功能">v1.0.3 功能</a> · <a href="#-配置">配置</a> · <a href="#-常见问题">常见问题</a></p>
</div>

---

## ✨ v1.0.3 功能

| 功能 | 说明 |
|---|---|
| **模型能力自动适配** | 根据模型族动态显示画幅、质量、背景、风格、数量和参考图入口；支持 `gpt-image`、`dall-e`、`nano-banana / banana`、`gemini image`、`seedream`、`flux`、`grok image` 等关键词匹配。未知模型自动回退到 **Generic OpenAI Compatible**，不会被白名单拦截。 |
| **多参考图 / 图生图** | 左侧 Prompt 下方可选择、拖入或粘贴最多 4 张 PNG / JPEG / WEBP，后端通过兼容的 `/v1/images/edits` 发送（单张用 `image` 字段，多张按官方约定用 `image[]`）。结果和文生图共用显影、历史墙、灯箱与本地元数据流程。 |
| **多行连拍队列** | 提示词一行一条，多行即整批入队顺序生成（上限 20 条）。进度实时上屏、出图即进墙，可随时「取消连拍」——取消在下一条前生效，不打断正在上游执行的请求，避免重复计费。 |
| **收藏与批量管理** | 卡片星标收藏、只看收藏筛选、灯箱内收藏切换；批量管理模式可勾选多张一次删除；「导出元数据」一键下载全部历史记录的 JSON 备份（不含图片本体）。 |
| **中转站健康检测** | 设置页打开时异步检测各站的 `/v1/models`，显示未检测、正常、较慢、限流、不可用和 `latency_ms`；状态缓存 45 秒，也可手动重新检测。 |
| **安全故障切换** | 默认关闭。开启后仅在 429 / 502 / 503 / 504 或明确连接失败时尝试一次拥有相同模型的备用站；400 / 401 / 403 和不确定的超时不会重试，避免重复生成和重复计费。 |
| **本地历史与三套主题** | 瀑布流历史墙、筛选、分页、灯箱、显影动画和暮金 / 黛夜 / 宣纸主题；历史浏览基于内存索引，图片上千张也不会拖慢页面。 |

v1.0.3 相比 v1.0.2 的改进：

- **生成体验**：多行提示词连拍队列（进度、取消、单条失败不中断整批）；参考图从 1 张扩展到 4 张。
- **历史墙**：收藏 / 只看收藏、批量勾选删除、元数据导出备份；侧边元数据写入改为原子写。
- **视觉升级**：三套主题整体重做为画廊质感——发丝线边框、玻璃药丸控件、胶片颗粒、渐变标题与立体主按钮；齿轮换 SVG 图标；暗房显影相纸加裁切标记。
- **架构加固**：`config.json` 改为原子写入（临时文件 + 替换）并加并发锁，杜绝写坏配置；健康状态与模型缓存移入独立的 `runtime_state.json`，生成不再反复重写用户配置；模型缓存按中转站隔离，多站切换互不清空；历史浏览走内存索引，目录无变化时零磁盘读取。

## 🚀 快速开始

```bash
git clone https://github.com/lmz-666-lmz/image-studio.git
cd image-studio
pip install -r requirements.txt
python app.py
```

打开 `http://127.0.0.1:7860`。首次使用点右上角设置，添加任意 OpenAI Compatible 中转站（地址可带或不带 `/v1`），测试连接后保存。

基本流程：

1. 选择或手填模型，拾光会自动识别模型能力。
2. 输入 Prompt；需要图生图时点「＋ 参考图」，选择、拖入或粘贴图片。
3. 点击「开始生成」或按 `Ctrl + Enter`。结果自动保存到 `outputs/` 并进入历史墙。
4. 在设置中查看各中转站健康状态，按需开启「生成失败时尝试备用中转站」。

## 🖼 参考图与历史

参考图支持 PNG、JPEG、WEBP，单张不超过 10MB，最多同时 4 张（可多选、拖入多张或直接粘贴）。已知不支持 edits 的模型会显示轻量提示；未知模型保留通用兼容模式，由中转站决定是否支持。多张参考图是否被接受同样由中转站决定。图生图记录会在同名 `.json` 中写入：

```json
{
  "mode": "image-to-image",
  "reference_used": true,
  "reference_name": "reference.png",
  "reference_count": 1
}
```

文生图记录使用 `mode: "text-to-image"` 和 `reference_used: false`。收藏的照片会写入 `"favorite": true`；旧历史缺少这些字段时按文生图、未收藏显示，仍可正常浏览。

## 🩺 健康状态与备用线路

健康检测只请求 `GET /v1/models`，不会产生付费生图。状态含义：

- `正常`：请求成功且延迟低于 1.5 秒
- `较慢`：请求成功但延迟达到 1.5 秒或以上
- `限流`：上游返回 429
- `不可用`：连接失败或返回 502 / 503 / 504 等错误

备用线路开关默认关闭。开启后，主站发生明确线路级故障时，拾光只会从已缓存模型列表中选择一个拥有**相同模型名**的备用站，并最多发起一次备用请求。参数错误、鉴权错误和可能已经在上游执行的超时不会自动切换。成功切换后当前使用中的中转站会更新，历史元数据包含：

```json
{
  "provider_id": "provider_x",
  "provider_name": "备用线路",
  "failover": true,
  "failover_from": "主线路"
}
```

## ⚙️ 配置

配置保存在本地 `config.json`（首次使用可复制仓库里的 `config.example.json` 为 `config.json` 再填入自己的地址和密钥），升级不会删除旧字段、旧中转站或用户历史。下面是脱敏示例，真实 API Key 不要提交到仓库：

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
    }
  ],
  "active_provider": "provider_1"
}
```

设置接口不会把完整 API Key 返回给浏览器；编辑时密钥留空表示保持原值。`outputs/`、`config.json` 与 `runtime_state.json` 已加入 `.gitignore`。

`runtime_state.json` 是运行时状态文件（健康检测记录等），首次健康检测时自动创建，删除后会自动重建，不影响任何配置和历史。

## 🖼 效果预览

<div align="center">

![主界面 · 暮金](screenshots/wall-darkroom.png)

<table>
  <tr>
    <td width="33%" align="center"><img src="screenshots/settings-providers.png" alt="中转站设置与健康状态"><br><sub><b>中转站设置</b> —— 添加、编辑、切换与健康检测</sub></td>
    <td width="33%" align="center"><img src="screenshots/generating.png" alt="显影动画"><br><sub><b>显影动画</b> —— 红光扫过，裁切标记，实时计时</sub></td>
    <td width="33%" align="center"><img src="screenshots/lightbox-info.png" alt="灯箱信息面板"><br><sub><b>灯箱</b> —— 缩放平移、生成信息与收藏</sub></td>
  </tr>
</table>

</div>

## 🌄 三套主题

`darkroom` 暮金、`ink` 黛夜、`paper` 宣纸。设置中点击即换并自动保存，无需刷新。

<div align="center">
<table>
  <tr>
    <td width="50%" align="center"><img src="screenshots/wall-ink.png" alt="黛夜主题主界面"><br><sub><b>黛夜</b> · ink</sub></td>
    <td width="50%" align="center"><img src="screenshots/wall-paper.png" alt="宣纸主题主界面"><br><sub><b>宣纸</b> · paper</sub></td>
  </tr>
</table>
</div>

## 📁 项目结构

```text
image-studio/
├── app.py              # Flask API、能力识别、多参考图、连拍队列、健康检测与 failover
├── requirements.txt    # 仅 Flask
├── static/index.html   # 页面结构
├── static/style.css    # 三主题画廊质感样式
├── static/app.js       # 生成、连拍、参考图、历史墙、收藏、灯箱与 GSAP 动效
├── screenshots/        # README 预览图
└── outputs/            # 本地生成图片与同名 JSON（运行时创建）
```

## ❓ 常见问题

<details><summary><b>为什么某个模型没有质量 / 背景参数？</b></summary>

拾光会根据模型能力动态显示参数，并在发送请求前过滤不支持的字段，避免上游因无效参数返回 400。未知模型使用 Generic OpenAI Compatible 通用模式。
</details>

<details><summary><b>为什么图生图按钮不可用？</b></summary>

已知模型如果没有声明 `image_to_image` 能力会显示提示。可以切换支持 edits 的模型；未知模型不会被拾光武断禁止，但最终是否支持由中转站决定。
</details>

<details><summary><b>为什么生成失败没有自动换站？</b></summary>

备用线路默认关闭，并且只对明确线路故障（429 / 502 / 503 / 504 或连接失败）切换一次。400、401、403 和不确定的超时不会重试，这是为了避免重复生成和重复计费。备用站还必须缓存有当前相同模型。
</details>

<details><summary><b>健康检测会扣费吗？</b></summary>

不会。健康检测只调用 `/v1/models`，并按 45 秒缓存；设置页打开时异步执行，也可手动重新检测。
</details>

<details><summary><b>升级后原来的配置和历史还在吗？</b></summary>

在。旧版单站 `api_base` / `api_key` 会自动迁移为 providers，旧图片和旧 JSON 继续可读，新字段会提供默认值。
</details>

---

MIT License · Image Studio · 拾光 · v1.0.3
