# dsh-gemini-kitten-widget 🐱

给 **DSH Web 界面**右下角常驻的一只 **Q 版 Gemini 猫娘**，实时显示 Gemini API 免费层的
**今日已用 / 剩余次数**。

```
        ╭──────────────────╮
        │ 还有 12 次额度躺着 │     ← 点一下换台词
        │ 睡觉呢，真浪费喵。 │
        ╰────────┬─────────╯
            (\_/)                   💜 蓝紫长发
           ( ^ω^ )                  👂 猫耳
           /|   |\                  👁️ 异色瞳（左蓝 #4285F4 / 右紫）
        ┌────────────┐              😼 坏笑 + 小虎牙
        │ ✦ 8 /20    │
        │ ▓▓▓▓░░░░░░ │              ← 用掉 80% 变橙、95% 变红
        │剩12次·13h后 │
        └────────────┘
```

## 配额口径（**这一节最重要**）

| 项 | 值 | 出处 |
|---|---|---|
| 限额 | **20 次 / 模型 / 天** | Google API 的 429 原文 |
| 重置 | **UTC 午夜**（= 北京次日 08:00） | 同上，由 `retry in` 反推 |
| 统计范围 | **只算 DSH 内**的调用 | 见下 |

**429 原文**（2026-10-15 两次独立实测，存放在 `~/.dsh/facts/gemini-free-tier-quota.json`）：

```
Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
limit: 20, model: gemini-3.8-flash
Please retry in 13h23m35s.
```

> ⚠️ **历史更正**：本插件最初按"250 次/天、太平洋时间午夜重置"实现（那是用户侧的口径）。
> 2026-10-15 晚拿到 API 原文后**已改正**为 20/模型/天 + UTC 午夜。
> 分母可用环境变量 `DSHK_QUOTA_PER_MODEL` 覆盖，时区用 `DSHK_QUOTA_TZ`（配额随时可能变，
> 别把它焊死在代码里）。

### 两个必须知道的局限

1. **只统计 DSH 内发起的调用**。你在 Gemini CLI / AI Studio / 其他脚本里消耗的配额，
   本挂件**看不到** —— 所以挂件数字**天然 ≤ 真实剩余**。
2. **配额是按模型分别算的**。挂件主显示盯着"**最紧的那个模型**"（用掉最多的），
   悬停可以看到各模型明细。`gemini-3.8-flash` 用完不影响 `gemini-3.7-flash`。

## 她会主动说话（阈值提醒）

平时她安安静静的，只在**你该知道的时候**开口 —— 而且**每个配额日每条只喊一次**，不会刷屏：

| 什么时候 | 她会说 |
|---|---|
| 某型号**实测用尽**（429 原文确认过） | 「`型号` 今天的额度用光了喵 —— 再派它就要撞 429，白烧一轮。」 |
| 最紧的型号到了 **80%** | 「最紧的 `型号` 只剩 `N` 次喵，省着点用。」 |
| 别处的会话消耗了额度（今日合计上涨） | 「有人叫哈基米了喵 —— 今天累计 `N` 次。」 |

> **为什么第一条最重要**：免费层是**每模型 20 次/天**，撞 429 就等于**白烧一轮子代理** ——
> 而官方不提供"还剩几次"的查询，所以"快要撞墙了"这件事必须有人**主动告诉你**，而不是等你去查。
>
> 去重状态存在浏览器的 `localStorage`（键 `dsh-kitten-widget:alerts`），**跨配额日自动作废**；
> 清掉浏览器数据后她会重新喊一次，属正常。

## 数据从哪来

两道口子，**按权威度排序**：

1. **DSH 会话日志**（权威）——`~/.dsh/sessions/**/session.v4.jsonl.zstd` 里每条
   `assistant/message` = 一次模型响应 = 一次 API 调用。
   日志是**多帧拼接的 zstd**，本插件逐帧解压、按 mtime/size 增量缓存（稳态 ~0ms）。
2. **鲸鱼娘账本**（兜底）——`~/.dsh/.dshw-usage.json` 的 `events`。
   ⚠️ 它是**按 turn 聚合**的：一个 turn 里 agent 可能问模型几十次，它只写一条。
   **所以账本条数 ≠ 调用次数**，只在日志读不到时兜底。金额（cost）也来自这里。

## 台词与梗库

内置台词写死在 `assets/kitten.js` 的 `LINES`；**私货**另存于 `~/.dsh/widget-lines.json` 的 `kitten` 段——
host 半随 `/dsh-kitten/state` 一起下发，客户端**追加**（不覆盖内置），**改完刷新页面即生效、无需重启**。

```json
{
  "kitten": {
    "ok":     ["今天也要好好写代码喵。"],
    "warn":   ["换个型号使唤本喵吧，兄弟们还有力气喵。"],
    "danger": ["换一位吧，本喵这个型号今天真没劲了喵。"]
  }
}
```

占位符：`{used}` 已用次数 · `{remaining}` 剩余 · `{limit}` 每日上限 · `{model}` 当前型号短名。

> ⚠️ **视角纪律**：这是**哈基米（Gemini）**的嘴，只说她自己的事。
> 她是**猫娘**，别让她自称别的角色（写串了会很怪）。
> 同一个文件的 `whale` 段是鲸鱼娘视角的**素材仓库**（她是第三方插件，落地方式见该段的 `note`）。

## 交互

| 操作 | 效果 |
|---|---|
| **拖动** | 移动挂件；松手后自动**吸附**到最近的屏幕边缘（吸附区 = 视口 12%，贴边 4px） |
| **单击猫娘** | 换一句台词（台词随额度状态变化） |
| **单击徽章** | **切换查看哪个型号**（配额按模型独立，一轮只放得下一行） |
| **拖到屏幕左半边** | 立绘**镜像翻转**（脸朝右），让她始终面向屏幕中央 |
| **右键** | 回到默认位置（鲸鱼挂件上方） |
| **悬停** | 全部型号的明细 / 重置时间 / 数据来源 |

位置**同时存两份**：服务端 `~/.dsh/gemini-kitten-widget/pos.json`（跨重启的真源）
+ `localStorage`（本次会话的快速缓存）。所以**重启 DSH 也不丢**——
桌面版每次重启 Web GUI 端口都会变，`localStorage` 按 origin 隔离，光靠它撑不过一次重启。

## 安装

**方式一：直接从仓库装**（推荐）

```
# 在 DSH 会话里对 agent 说：
#   plugin_manager install_bundle  target = git+https://github.com/Void-LifeStream/dsh-gemini-kitten-widget
```

**方式二：先 clone 再用本地 link**

```powershell
git clone https://github.com/Void-LifeStream/dsh-gemini-kitten-widget
```

```
# 然后让 DSH 装本地目录（桌面端读 desktop profile，CLI 拒绝 --profile desktop）：
#   plugin_manager install_bundle  target = link:<clone 下来的绝对路径>
```

⚠️ **装完必须重启 DSH**：桌面端（Electron）的注入表是**宿主启动时一次性收集**的，
插件在运行期被加载时这一行进不了表 ⇒ 挂件不出现。**web 形态**（`dsh web`）走 `tapIndex`，同样建议重启一次。

⚠️ **依赖**：无。不需要任何 API key —— 本插件**只读本机数据**（DSH 会话日志 + 可选的余额账本），
**从不联网**、不写配置、不碰凭据。

⚠️ **它对"没装鲸鱼娘挂件"的环境同样可用**：账本只是兜底数据源，没有它时会话日志照常工作。

## 技术形态

```
dsh-gemini-kitten-widget/
├─ package.json          dsh.bundle.patch → cordis.patch.yml
├─ cordis.patch.yml      挂载声明（insert 一条）
├─ lib/index.js          host 半：注入行 + 三只读路由 + 位置读写 + 配额统计
├─ assets/kitten.js      client 半：渲染 + 拖拽吸附/翻转 + 位置同步 + 台词 + SVG 兜底
├─ assets/kitten-art.png 形象立绘（本地生成，透明 PNG）
└─ tools/                自测与出图脚本（见下）
```

**两条注入通道**（桌面端与 web 形态各一条，各自去重）：

1. `webserver/index-inject` 推 **内联 `<script>` 行** —— 桌面端唯一通道。
   用内联行而不是 `script-src` 行：页面侧对 `script-src` 是「加载失败即 reject 整个 boot」，
   插件被关掉时路由注销 ⇒ 404 ⇒ **应用起不来**。内联行自己建 `<script src>` 并吞掉 `onerror`。
2. `webServer.tapIndex` 往 `index.html` 注入 `<script defer>` —— web 形态通道。

**路由**（三个只读 + 一个读写）：

| 路由 | 作用 |
|---|---|
| `GET /dsh-kitten/widget.js` | 客户端脚本，URL 带 **mtime 指纹**（改完刷新即生效，无需重启） |
| `GET /dsh-kitten/art.png` | 形象立绘，ETag 走 mtime |
| `GET /dsh-kitten/state` | 配额 JSON |
| `GET/POST/DELETE /dsh-kitten/pos` | 挂件位置，**跨重启持久化**（见下） |

**安全姿态**：前三条只读、不含凭据，沿用「`Sec-Fetch-Site: cross-site` 一律拒」
+ 委托宿主的 `connection.requestRejection`。

`/pos` 是本插件**唯一的写接口**，额外加了三道限制：body 上限 **1 KiB**、
只接受 `{ left, top }` 或 v:2 锚点（两个非负有限数）、写入走「临时文件 + rename」原子替换。

**位置为什么存服务端**：DSH 桌面版用 `--port 0` 启动，每次重启 Web GUI 端口都变，
而 `localStorage` 按 origin 隔离 ⇒ 光靠它每次重启都会清空。位置格式采用
「锚点 + 距离」（`{ v:2, hAnchor, hDist, vAnchor, vDist }`），这样窗口化 ↔ 全屏切换时
挂件会跟着视口重新映射，而不是钉在旧像素位置。

### 开发

- **只改 `assets/kitten.js` 或 `kitten-art.png`** → 刷新页面即生效（mtime 指纹绕开缓存）。
- **改了 `lib/index.js`** → 需要重启 DSH。
- 改配额口径：`DSHK_QUOTA_PER_MODEL=20`、`DSHK_QUOTA_TZ=UTC`。

- **发布前先跑 `node tools/sync-check.cjs`** —— 检查本地开发目录与 GitHub 远端的差异。

  为什么需要：本机那份开发副本**不是 git 仓库**，和远端之间**没有任何自动同步**。
  2026-10-19 发 0.1.3 时才发现远端有 `LICENSE` / `CHANGELOG.md` / `.gitignore` / `docs/`
  而本地一个都没有 —— 这类差异要到 `npm publish` 那一刻才暴露。

  快检只比文件列表（1 次 API 调用，约 1 秒）；想看内容差异加 `--deep`。
  它**只报告、不改任何文件** —— 看到差异后仍需人工确认，别盲目覆盖。

### 自测脚本（本机 node 不在 PATH 里，用 DSH 运行时那个）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node tools\selftest.mjs   # host 半离线自测：注入行 / 路由 / 配额算法
& $node tools\logtest.mjs    # 日志计数器：增量解帧 / 半截帧 / 截断重写（13 项）
& $node tools\uitest.mjs     # 浏览器回归：立绘 / 回退 / 拖拽吸附 / 台词 / 三档变色（19 项）
& $node tools\shot.mjs <输出目录>   # 出预览图
```

抠图（重新处理形象）用 ComfyUI 自带的 python：

```powershell
& python tools\cutout.py <源图> assets\kitten-art.png 480
```

### 血泪避坑（写给下一个改它的人）

1. **客户端脚本里绝不能 `require()` 内置符号**（`styles` / `host` 是 seed word）——
   后果是**整个 web boot 失败**、应用弹「无法启动」。要插样式就自建 `<style>` 并 `appendChild`。
2. **初始化路径上任何异常都会让挂件「活着但点不动」**（被空 catch 静默吞掉）——
   此处所有早退分支都打 `console.error`，不静默。
3. **注入行必须最早注册**：桌面端的注入表一次性收集，晚一步就永远进不去。
4. **别用账本条数当"调用次数"**（按 turn 聚合，会严重低估）。
5. **多帧 zstd 要逐帧解**：`zstdDecompressSync` 只解第一帧，直接读会得到 1 行。

## 形象来源

**本地 ComfyUI（anything-v5）生成 + `transparent-background` 抠图**，纯本地、零成本、不出网。

> 为什么不用网上现成的"猫娘二创"：画师作品**默认保留全部权利**，Gemini 娘的同人图
> （如 B站 ZipZipPipe 那版）属"参考风格"而非可再分发素材；DSH 插件生态里的桌宠素材
> 多绑定各自的皮肤/角色授权。**自己生成是唯一既干净又能贴合"蓝紫发 + 猫耳 + 异色瞳"设定的路。**

灵感参考：ZipZipPipe 的「Gemini 娘」二创（B站原帖 `1233069202138464289`）。

## 授权

MIT
