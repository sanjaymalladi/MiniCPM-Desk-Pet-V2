# v0.2 — 2026-05-18

## 新增

### 设置面板
- `Settings → 🐾 MiniCPM` 标签页:
  - 当前模型 / 适配器 / 人格 / 设备实时状态
  - 模型更新检查 + 一键应用
  - LoRA 下拉切换(切换会清空对话历史)
  - 聊天生成参数:Temperature / Top-p / Top-k / Repetition penalty / Max tokens / 默认思考模式
  - 桌宠主动旁白开关
  - 气泡位置可视化:左/右/自动 + 拖动微调

### LoRA 适配器
- 新增 `adapters/lora_nekoqa_adapter_*` (猫娘版)
- 聊天里说 "用猫娘" / "切回原版" / "用 base" 直接切换
- 切换 / 切回都用 LLM 意图分类做模糊匹配,不只支持精确字符串
- 切到当前已加载的 adapter 会提示 "已经是 X 了" 而不是空切

### 桌宠主动旁白(narration)
- 监听 Cursor / Claude Code / Codex 的完成事件
- 用 base 模型(`disable_adapter=true`)生成一句简短点评
- 节流 + 去重逻辑,避免刷屏
- 旁白文本带上当前会话标题 + 上一轮 assistant 摘要做语境

### 桌宠 narration 增强(本轮新增)
- **多窗口 FIFO 队列**:多个 IDE/CLI 同时完成时,排队依次播报(最多 5 条,session 去重)
- **事件 merge 评分**:Cursor + Claude Code 同时为一个 session 触发 hook 时,
  自动选 transcript 上下文最丰富的那条(避免被空 stop 抢先吃掉 dedup 槽)
- **Claude Code transcript 解析**:之前只有 Cursor 抓 title+summary,
  现在 Claude Code 也抓:首条 user 当 title,末条 assistant text 当 summary
- **race-condition 修复**:Claude Code stop hook 在 transcript 写盘前触发的
  bug,现在会等文件大小稳定 (max 1.2s) 才解析
- **Prompt 重写**:对所有 agent 统一"主人刚结束跟 AI 关于 X 的对话"框架,
  few-shot 改成"旁观者"视角(不冒充 AI 说话),减少 0.9B 模型的语病和角色混淆

### UI/UX
- 聊天气泡:
  - 拖动调整位置后会记住(`<userData>/minicpm-bubble-pos.json`)
  - 默认在桌宠左侧,屏幕边缘自动翻到右侧
  - 输入框气泡尺寸自适应,长文本自然换行不截断
  - 命令回复 / 错误提示用独立的 `showCommandReply` 路径,带 fade
- 全局快捷键:
  - `⌘⇧M`: 开关聊天气泡
  - `⌘⇧T`: 切换思考模式显示
  - `Esc`: 关闭气泡(仅气泡内有焦点时)

### Sidecar
- 新增端点:
  - `GET /api/adapters` — 列出可用 LoRA
  - `POST /api/load-adapter` — 切换 / 卸载 LoRA
  - `GET /api/update-check` — 检查模型新版
  - `POST /api/update-apply` (SSE) — 流式应用模型更新
  - `POST /api/classify` — first-token logit 意图分类
  - `POST /api/warmup` — 把模型权重 fault 回 RAM,降低空闲后冷启动延迟
- `ChatRequest` 新增字段:
  - `top_k`(原来只支持 top_p)
  - `silent` — 不推送桌宠状态(narration / 后台调用用)
  - `disable_adapter` — 这次请求不走 LoRA(分类 / 旁白用)
- 启动时双路 warmup:同时预热采样 + 贪心 kernel,首条消息不再卡顿
- 打开聊天气泡时后台 warmup ping,你打字的同时模型在 fault back
- `_safe_print` 包裹所有日志,sidecar 在 BrokenPipe 时不崩

### 一键安装(uv 版本独有)
- `./go.sh` 自动检查 macOS / Node 18+ / uv,缺失自动装
- Node 优先 brew,无 brew 用 fnm 装一份(无 sudo)
- uv 一行 curl 装
- 子命令: `./go.sh doctor` / `setup` / `start` / `run`

## 改动

- 默认 `thinking=false`(LoRA 没在 `<think>` 上训练,开了会卡住)
- chat 默认 `max_new_tokens=768`
- 聊天 UI 用主进程 IPC 拉取参数,Settings 改完下条消息立刻生效
- `pickSide` 支持用户偏好(原来固定右侧优先)
- 默认气泡偏移调成 `dx=-45, dy=45`(贴合默认猫的实际像素)

## 修复

- 切 adapter 之后历史不清空导致人格污染 — 现在 reset
- 命令分类(切 / 切回 / 切回 base)在否定句和模糊表达上漏检 — 加了更多 few-shot,现在能识别 "我不要用猫娘了" 之类
- 编辑气泡位置时旁白会插话 — 编辑期间禁用旁白
- 聊天气泡 macOS 焦点丢失 — 加了显式 `bubble.focus()` IPC
- Claude Code stop hook 抓到上一轮 assistant 内容 — race condition fix

## 内部 / 不影响用户

- 新增 `clawd-on-desk/src/settings-tab-minicpm.js`
- 新增 `clawd-on-desk/src/minicpm-chat.js`(原来在 main.js 里)
- 派生状态机:`overload` / `failure-streak` 自动 push
- agent 事件里的会话标题 / 上一轮摘要传给旁白做语境

## 已知问题

- LoRA 切换需要 ~2-4s,过程中桌宠的 thinking 动画会持续转
- Q4 量化 + 0.9B 还没做(还在 transformers 路径)
- 朋友的 conda 环境如果 setup.sh 没跑过,upgrade.sh 不会自动建
- 0.9B 模型 narration 偶尔翻车(改关键词、出语病),0.9B 容量上限
- Codex agent 还没接 last_summary 解析(只有 thread_name)
