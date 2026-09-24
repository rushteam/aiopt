# AiOpt

[English](README.md) | 简体中文 | [日本語](README.ja.md) | [한국어](README.ko.md)

**一个供应商池，接入所有 Agent CLI，打通各种接口格式。**

AiOpt 是一款桌面应用，把你的 AI 编程 Agent 路由到你真正想为 token 付费的模型供应商。供应商只需录入一次
——接口地址、密钥和模型——然后一键让 Claude Code、Codex、Gemini CLI、OpenCode 或其他受支持的 Agent 使用它。
当 Agent 与供应商的接口格式不一致时，AiOpt 的本地代理会在两者之间转换：Codex 可以跑在 Anthropic 模型上，
Claude Code 也可以接任意 OpenAI 兼容的接口，无需维护任何启动参数、包装脚本或环境变量。

## 为什么是 AiOpt

每个 Agent CLI 都有自己的配置文件、自己的密钥位置，也有自己认定的接口格式。换个模型，就得手动改
`~/.claude/settings.json`，再改 `~/.codex/config.toml`，再去别处改一个 YAML——同一个密钥还要到处粘贴。
而 Agent 不支持的接口格式的供应商，根本没法用。

AiOpt 用一个统一的供应商管理入口、每个 Agent 一个切换开关，以及一层消除格式差异的转换层，取代了这一切。

## 功能

### 供应商池

- **录入一次，处处复用。** 一个供应商就是名称、接口格式、Base URL、密钥和模型列表。所有 Agent 共用同一个池。
- 内置 Anthropic、OpenAI、DeepSeek、Moonshot（Kimi）**预设**，也可以选 **自定义…** 接入任意网关、中转或
  自建接口。
- **加载模型**，直接从供应商的模型列表读取，不必手敲模型 ID。
- **别名**：写入 Agent 的是更短或更符合 Agent 习惯的名字，而不是冗长的模型 ID。
- **上游兼容性**：转发前剥离指定的顶层请求字段，适配那些遇到不认识的参数就直接拒绝、而不是忽略的严格网关。

### 一键绑定 Agent

可识别九个 Agent CLI：**Claude Code、Codex、Cursor、DeepSeek Harness、Gemini CLI、Grok、Hermes、OpenCode
和 pi**。其中八个可以绑定供应商；Cursor 的 CLI 无法覆盖 base URL，因此只参与技能同步。

- 在 Agent 卡片上选好供应商和模型并应用即可。AiOpt 写入的是该 Agent **自己的原生配置文件**，所以 Agent 的
  运行方式与之前完全一样——没有启动器，也没有 shell 别名。
- **独占**模式的 Agent 会替换当前生效的供应商；**追加**模式的 Agent（DeepSeek Harness、Hermes、OpenCode）
  会并列保留所有供应商，只切换默认项。
- 第一次写入任何文件之前，AiOpt 都会把**原始文件**保存为 `<file>.aiopt.bak`。**恢复默认** 会原样还原它
  ——如果文件是 AiOpt 创建的，则直接删除。
- **查看配置** 列出 AiOpt 管理的文件及其位置，但从不显示文件内容（其中有几个保存着密钥）。

### 跨格式转换代理

| Agent 使用 → 供应商使用 | 状态 |
| --- | --- |
| Anthropic Messages → OpenAI Chat Completions | 已启用 |
| OpenAI Responses → OpenAI Chat Completions | 已启用 |
| OpenAI Responses → Anthropic Messages（带推理桥接） | 已启用 |
| OpenAI Chat Completions → Anthropic Messages | 预留 |

- **一个回环服务器、一个 `127.0.0.1` 端口、每条绑定一条路由。** 每条绑定在 URL 路径中带一个不透明的 token；
  由路由——而不是对请求体的猜测——决定转换方向，所以相反方向的绑定共用同一端口也互不干扰。
- **流式输出和工具调用都会转换**，而不只是纯文本——Server-Sent Events 在两个方向上逐个事件重新组帧。
- **推理桥接** 让 Claude 的扩展思考块及其签名能够穿过无状态的 Responses 协议，所以在 Claude 模型上运行的
  多轮 Codex 会话，推理过程不会断。
- **无法如实转换的字段会被拒绝**，并给出明确的错误，而不是悄悄丢掉——Agent 不会在不知情的情况下拿到不一样的结果。
- **重启后保持不变。** 端口和每条绑定的 token 都会持久化，已经在运行的 Agent 在 AiOpt 重启后照常工作。绑定一旦
  重新指向，token 立即更换；绑定清除后，token 随之失效。端口被其他程序占用时，用 **刷新端口** 换一个即可。

### 代理模式

- **关闭（默认）：** 同格式的绑定让 Agent **直连**供应商，即使 AiOpt 没有运行也能继续工作。由于 Agent 需要自己
  发送密钥，供应商密钥会写入 Agent 的配置文件。
- **开启：** 所有绑定都经过本地代理。此时 Agent 的配置里只有一个回环 token，**真正的密钥从不离开 AiOpt 的加密
  存储**，并且会统计用量。有 Agent 依赖代理时，AiOpt 退出前会先征求你的确认。
- 跨格式绑定始终走代理；Gemini 绑定始终直连。

### 统计

对经过代理的流量统计请求数、成功率以及输入 / 输出 / 总 token，提供每日图表，并可**按供应商、按 Agent、按模型**
细分。只读取响应中的数值用量字段——从不读取内容。

### 技能同步

把 Agent 的技能集中放在一个**中央库**里（位于应用数据目录，或 `~/.aiopt/skills`），再同步到每个 Agent 的技能目录：

- 用 **拉取 ←** 把 Agent 的技能收进中央库，用 **推送 →** 把中央库的版本发给某个 Agent，或者一次 **推送到全部 Agent**。
- **对比** 显示文件级改动并可预览内容；**合并** 让你逐个文件决定中央库保留哪一边的版本。
- 每次覆盖都是原子操作。符号链接会被拒绝，并且有大小上限，所以误放的链接或失控的目录不会被复制过去。

### 日常体验

- **复制代理配置** 把某条代理路由的 OpenAI 兼容配置片段复制到剪贴板，方便让其他工具也接入同一条路由。
- 常驻**菜单栏 / 系统托盘**；关闭窗口后代理照常运行。
- **七种界面语言**（English、简体中文、日本語、한국어、Français、Deutsch、Español），浅色 / 深色 / 跟随系统主题，
  快捷键可自定义。

## 快速开始

### 安装

构建产物附在每个 [GitHub Release](https://github.com/rushteam/aiopt/releases) 上，由打标签的提交在三个平台上分别构建：

| 平台 | 下载内容 | 安装方式 |
| --- | --- | --- |
| macOS | `.zip` | 解压后把 **AiOpt.app** 拖入 `/Applications`。 |
| Windows | `Setup.exe` | 直接运行；Squirrel 按用户安装，不弹管理员权限提示。 |
| Linux | `.zip` | 解压到任意位置，运行 `AiOpt` 可执行文件。 |

**macOS 构建目前仅支持 Apple Silicon（arm64）。** 在 Intel Mac 上请从源码运行。

#### 构建产物未签名——请先阅读

目前还没有代码签名证书，所以 **macOS 和 Windows 在首次启动时都会拒绝运行该应用。** 这是一道需要你刻意跨过的
拦截，每次安装一次：

- **macOS**——首次双击会提示无法打开“AiOpt”，因为无法验证开发者。关闭提示后，**右键（或按住 Control 点按）
  应用 → 打开**，并在第二个对话框中确认。如果 macOS 仍然拒绝，打开**系统设置 → 隐私与安全性**，滚动到关于
  AiOpt 的提示，点击**仍要打开**。
  如果提示的是 AiOpt **已损坏，无法打开**，请看[常见问题](#常见问题)。
- **Windows**——SmartScreen 会显示蓝色的“Windows 已保护你的电脑”界面。点击**更多信息**，然后点击**仍要运行**。
- **Linux**——不会拦截该应用。

只有在你信任文件来源时才这样做——恶意软件也会要求你执行同样的步骤。签名已在计划中
（见 `docs/dev-rules/development-workflow.md` §6）。

### 首次运行

AiOpt 负责为你的 Agent CLI 管理配置和格式转换，它自身不会与模型通信。

1. **添加供应商**——供应商 → **添加供应商**。选择预设或 **自定义…**，粘贴 API 密钥，加载或手动列出你要用的
   模型。密钥存入操作系统加密的密钥存储。再次打开表单时显示的是“已保存密钥”而不是密钥本身；只有按下 **显示**
   时才会再次显示。
2. **绑定 Agent**——在 Agent 卡片上点 **配置**，选择供应商和模型，然后 **应用**。AiOpt 会改写该 Agent 的配置
   文件（`~/.claude/settings.json`、`~/.codex/config.toml`……），让它指向供应商或本地代理。
3. **像往常一样使用 Agent。** 之后在同一张卡片上随时切换模型；**恢复默认** 会把 Agent 的配置原样交还。

**AiOpt 会编辑属于其他工具的配置文件。** 它只写入 `shared/aiProviders.ts` 中为每个 Agent 声明的特定文件，并且
每个文件都会先备份，但这些文件可能正是你手动配置过的。绑定之前，先用 **查看配置** 看一看。

## 常见问题

### macOS 提示“‘AiOpt’已损坏，无法打开。你应该将它移到废纸篓。”

文件并没有损坏。构建产物没有 Apple Developer ID 签名，也没有经过公证，而 macOS 会给所有通过浏览器下载的文件
打上隔离标记。于是 Gatekeeper 拒绝运行该应用；在 Apple Silicon 和较新的 macOS 上，它往往直接报“已损坏”——
没有**仍要打开**按钮，右键 → 打开也绕不过去。

先把 **AiOpt.app** 拖入 `/Applications`，然后在终端里清除隔离标记：

```sh
xattr -dr com.apple.quarantine /Applications/AiOpt.app
```

之后正常打开即可。如果仍然无法启动——一打开就退出，或者再次提示已损坏——给它补一个临时（ad-hoc）签名后再试：

```sh
codesign --force --deep --sign - /Applications/AiOpt.app
```

只对从本仓库 [Releases](https://github.com/rushteam/aiopt/releases) 页面下载的文件这样做。等构建完成签名和
公证后，就不再需要这一步。

## 设计

### 安全即架构

AiOpt 保管着 API 密钥，还会改写你主目录下的文件，所以安全模型就是它的架构本身，而不是外加的一层：

- **界面不可信。** 界面运行在启用了沙箱和上下文隔离、无法访问 Node 的渲染进程中。精简的 preload 只暴露按用途
  命名的方法；主进程中的每个 IPC 处理器在做任何事之前，都会**先校验发送方，再在运行时校验载荷**。
- **密钥由操作系统加密**，通过 Electron `safeStorage` 实现——macOS 上是钥匙串，Windows 上是 DPAPI，Linux 上在
  可用时使用桌面密钥环。密钥从不进入界面、日志或任何受版本控制的文件。
- **代理只监听回环地址**，用路由 token 认证每个请求，只把真正的密钥注入出站请求，从不转发上游错误响应体（其中
  可能回显密钥），日志只记录方法、路径、状态码和字节数——从不记录请求体、请求头、token 或密钥。
- **写入范围窄且可撤销。** 只允许写入明确列入白名单的 Agent 配置文件；每次写入都是原子操作（临时文件 + 重命名），
  并带一次性备份；写入失败时原文件保持不变。
- **失败即关闭。** 严格的主进程侧 CSP、锁定的 Electron Fuses 和导航守卫；加载时丢弃损坏的记录而不是信任它们；
  无法转换的字段一律拒绝。

### 工程

- **技术栈：** Electron 41、React 19、TypeScript（strict）、Vite 6、Electron Forge、Vitest、pnpm workspaces。
- **依赖精简。** 代理基于 Node 自带的 `http` 模块构建，不依赖任何第三方代理库或 SDK；转换器和 SSE 编解码都是纯函数，
  无需网络即可测试。
- **测试覆盖关键边界**——转换器、流式处理、路由 token、配置适配器、原子写入，以及 macOS、Windows、Linux 的路径
  处理；发布构建在三个平台上运行。
- **本地化受闸门管控。** 界面文案经过 i18n，产品术语在 CI 中对照已裁定的术语表检查。

## 从源码运行

这也是 Intel Mac 或任何没有附带构建产物的平台的途径。需要 Node 20+ 和 pnpm。

```sh
pnpm install
pnpm dev                # open the app window
```

从源码运行时，数据与已安装的副本相互隔离，存放在 `AiOpt-dev` 而不是 `AiOpt` 中
（位于 `~/Library/Application Support`、`%APPDATA%` 或 `~/.config` 下）。它启动时没有任何供应商，
也从不读取或修改已安装应用的密钥。两者可以同时运行。

## 参与贡献

欢迎贡献。每次提交都需要 DCO 签署——运行一次 `pnpm dco:install-hook` 即可自动添加。详见 `CONTRIBUTING.md`；
规则索引见 `AGENTS.md`（*“动 X 区域之前先读规则 Y”*）；`docs/dev-rules/repo-map.md` 是代码库地图。

| 命令 | 检查内容 |
| --- | --- |
| `pnpm test:unit` | 所有工作区单元测试（提交闸门）。 |
| `pnpm -r run --if-present typecheck` | 按包进行类型检查。 |
| `pnpm check:dco` | 每次提交都带有匹配的 DCO 签署。 |
| `pnpm check:i18n-glossary` | UI 文案使用已裁定的产品术语；`GLOSSARY.md` 保持同步。 |
| `pnpm check:version` | 两个清单文件声明同一个版本，并与发布标签一致。 |

## 许可证

[MIT](LICENSE) © 2026 RushTeam
