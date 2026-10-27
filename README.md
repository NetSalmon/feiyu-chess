# 肥鱼 CHESS

在本地网页中观看两个 AI 自动进行国际象棋对战。双方可分别使用任意支持 **Chat Completions + function calling** 的 OpenAI 兼容服务，并设置独立的 System Prompt。

## 运行

需要 Node.js 22 或更高版本。

```bash
npm install
npm start
```

打开 **http://127.0.0.1:3000**。端口被占用时：

```bash
PORT=3008 npm start
```

开发时可用 `npm run dev` 自动重启服务；运行 `npm test` 执行规则、API 和对局流程测试。

## 使用

1. 桌面端左侧为白方设置，右侧为黑方设置，中央为棋盘。展开各自的「API 连接设置」，填写完整的 API 请求 URL、API Key 和模型名称。模型名称请使用服务商提供的准确 ID。
2. API 请求 URL 请填写实际接收请求的完整地址，例如 `https://your-provider.example/v1/chat/completions` 或服务商提供的自定义端点。程序直接使用填写的 URL，不追加路径、不移除尾部斜杠，也不改写查询参数；走棋和赛后采访都使用此地址。本地无鉴权服务可不填写 Key。
3. 点击「开始对弈」。白方先行，每次合法落子后，服务端自动请求另一方，直至结束。浏览器页面关闭也不会中断后端正在运行的对局。
4. 点击头像可上传 PNG、JPEG 或 WebP 图片（最多 5MB，自动裁成正方形并压缩）。System Prompt 显示在指向头像的气泡中，点击「编辑」修改，点击「完成设置」回到气泡展示。双方的头像与 Prompt 独立设置。
5. 双方各自的「思考强度」滑条提供关闭、自动、轻量、均衡、深入五档。「关闭」对 DeepSeek 发送 `thinking: {"type":"disabled"}`，对其他服务发送 `reasoning_effort: "none"`；自动档不发送 `reasoning_effort`，其余档对应 `low`、`medium`、`high`。关闭思考和强度参数须由模型服务支持；不支持时选「自动」。
6. 可以暂停、继续、结束对局，翻转棋盘、复制 FEN，或导出 PGN。暂停后可修改双方模型配置、头像、Prompt 和思考强度，点击「更新当前对局配置」后继续。
7. 双方设置自动保存在当前浏览器，包含名称、头像、Prompt、思考强度、模型、完整 API URL 和 Key，以及对局选项；刷新或关闭后重新打开即可恢复。Key 以明文存入此站点的 `localStorage`。切换浏览器、主机名或端口会使用不同的浏览器存储。
8. 棋盘下方的「服务器对局记录」可选择并查看历史棋局、发言、采访或导出棋谱；新开一局不会删除旧记录。「试试本地演示」会展示一个四步愚人将杀棋局及示例赛后采访，不调用真实 API。

棋盘下方可直接设置「请求超时时限」，范围为 1–3600 秒，默认 60 秒，适用于每次走棋和赛后采访请求。对局中、暂停后或赛后都可以修改，再点击「应用到后续请求」；已发出的请求继续使用原时限。超时暂停后，可以增加时限，再继续对局；采访超时后也可增加时限再重试。刷新页面会恢复当前对局的超时设置。

「对局选项」中的落子间隔和最大半回合数在新对局开始时生效。一个半回合表示一方走一步；默认上限 400 个半回合，到达上限会标注为程序裁定和棋。

## 棋手发言

双方设置面板中的「棋手发言」以气泡展示模型的普通文字回复，包括带工具调用的文字、要求重试时的回复以及赛后采访。新消息出现在最上方，旧气泡向下移动；区域高度固定，可向下滚动查看历史，有新消息时自动回到顶部。消息以纯文本展示，保留换行，不执行 HTML；只展示 `message.content`，不展示 `reasoning_content`、工具参数或工具结果。当前使用非流式请求，气泡在每次 API 响应完整返回后出现。

每方最多保留最近 200 条可见发言，每条最多 16000 字符；完整的原始走棋对话仍单独保存在服务端上下文中。本地演示也会展示标注的示例发言，方便预览气泡效果。

## 赛后采访

棋局判定结束后，程序自动向双方各发起一次采访请求，询问对战体验、对胜负或和棋的感受，以及希望复盘的落子。采访沿用各自的模型、System Prompt、思考强度和完整对话历史，包含此前的落子工具调用与执行结果，并补充最终 FEN、PGN 和赛果；采访阶段不提供走棋工具。

采访结果在棋盘下方分别展示。采访错误或超时不会改变赛果，可点击「重试未完成的采访」仅重试失败的一方。真实对局的采访会额外消耗双方 API 用量；本地演示使用标注的示例感言。主动结束尚未判定的棋局不会发起采访。新开一局保留旧棋局及采访记录，已发起的采访继续在服务器完成。

## 走棋 Function Call

直接向用户设置的完整 URL 发起 `POST` 请求（配置字段仍为 `baseUrl`），以 Bearer Key 鉴权，发送双方各自的 `model` 和 System Prompt，通过 `tools` 注册以下函数，并设置 `tool_choice: "auto"`，由 Prompt 与服务端校验确保每回合只接受一次合法落子：

```json
{
  "type": "function",
  "function": {
    "name": "make_move",
    "description": "Play exactly one legal chess move in UCI notation.",
    "parameters": {
      "type": "object",
      "properties": {
        "move": { "type": "string", "description": "A legal UCI move." }
      },
      "required": ["move"],
      "additionalProperties": false
    }
  }
}
```

模型应返回 `message.tool_calls`，参数例如 `{"move":"e2e4"}`。王车易位使用 `e1g1`、`e1c1` 等；升变必须指定棋子，例如 `e7e8q`。程序在每次请求中提供当前 FEN、棋盘文本、PGN 和全部合法 UCI 走法，并在自定义 System Prompt 后附加落子协议。

非法走法、错误 JSON、未调用工具或一次调用多个工具都会收到纠正反馈；单回合连续三次失败则该方判负。API 的 HTTP 错误、连接失败或超时会暂停对局，修正配置后可以继续，不因此判负。服务商必须支持 `tools`；纯文本输出走法的模型接口不适用。没有调用工具时，程序会保留回复上下文并要求重试。未强制发送 temperature 或 token 上限参数，以减少不同服务商的兼容性差异。

接口格式参考 [OpenAI 官方 Function calling 文档](https://developers.openai.com/api/docs/guides/function-calling) 和 [Chat Completions 参数文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

## DeepSeek 兼容性

DeepSeek 思考模式不支持强制指定函数或 `tool_choice: "required"`，会返回 HTTP 400。本程序使用 `tool_choice: "auto"`，并在模型名以 `deepseek-` 开头或 API 主机为 `api.deepseek.com` 时显式发送 `thinking` 开关。「关闭」档发送 `{"type":"disabled"}` 并省略 `reasoning_effort`；其他档发送 `{"type":"enabled"}`，轻量、均衡、深入同时发送所选 `reasoning_effort`。双方各自的工具调用和未调用工具的 assistant 回复都会保留 `reasoning_content`，供后续回合使用。走棋与采访使用相同的思考参数。

例如：URL 为 `https://api.deepseek.com/chat/completions`，模型为 `deepseek-flash`，思考强度选「深入」时会发送 `reasoning_effort: "high"`。API 错误提示会显示脱敏后的 JSON `error.message`，不再只显示状态码；非 JSON 响应不会直接展示。参考 [DeepSeek Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/) 和 [思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 判定规则与存储

- 使用 [chess.js](https://github.com/jhlywa/chess.js) 在服务端生成和校验走法，支持王车易位、吃过路兵和升变。
- 自动判定将死、逼和、子力不足、三次重复局面与五十回合规则。本程序在三次重复和五十回合条件达到时直接判和，无需 AI 申诉；子力不足范围由 chess.js 决定。
- 服务器默认将每局保存为 `data/games/<对局 ID>.json`，每次状态变化自动写入，先写临时文件再原子替换。存档包含棋谱、规则历史、赛果、发言、日志、采访、双方身份与策略、完整模型对话上下文，以及超时等对局参数。服务器存档不因经过 24 小时而自动删除，新开一局也不删除旧局；可通过 `DELETE /api/games/<ID>` 明确删除。
- API Key 与完整 API URL 仅在当前服务进程内存中用于请求，不写入服务器存档、状态接口或日志。双方完整设置（包含 API 凭据）与最后查看的对局 ID 保存在浏览器 `localStorage`，下次访问同一地址自动恢复。浏览器存储失败会在界面提示。
- 服务重启后自动读取存档。未完成棋局恢复为暂停状态，完整棋谱与双方模型上下文保留；点击「继续对局」时，浏览器自动补回双方 API 配置。已完成棋局与采访直接恢复展示，中断的采访可补回浏览器配置后重试。服务器重启不会自行调用收费 API；另一台设备查看历史无需 Key，继续对局或重试采访则须提供 API 配置。
- 可通过 `FEIYU_DATA_DIR=/path/to/games PORT=3008 npm start` 指定存档目录。备份或迁移该目录即可保留服务器棋局记录；浏览器设置需单独保留。目录已加入 `.gitignore`。
- 默认仅监听 `127.0.0.1`。这是供本机使用的程序，不含用户认证；如需多人或公网访问，应先加入身份认证与访问控制。

## 结构

```text
server/game.js   对局状态机、规则判定、工具调用、上下文与赛后采访
server/app.js    HTTP API、SSE 实时事件、静态文件服务
server/storage.js 对局文件的原子保存、读取与删除
server/index.js  启动入口
public/         浅蓝中文界面、头像与 Prompt、棋盘、设置与实时记录
public/preferences.js 浏览器设置与最后查看对局的本地存储
test/           本地模拟 API 与规则/流程集成测试
```

不需要前端构建。页面与 API 同源，密钥经本地后端请求模型服务，避免浏览器跨域问题。

## 许可证

Copyright (C) 2026 NetSalmon。

本项目采用 **GNU General Public License v3.0（GPL-3.0-only）**。你可以按 GPL 第 3 版的条款使用、修改和再分发本项目；项目不提供任何担保。完整条款见 [LICENSE](LICENSE)。第三方依赖保留各自的许可证。

服务器对局存档、浏览器本地设置、API Key 和环境文件属于运行数据，不随源码发布。克隆项目后，在自己的浏览器中填写双方 API 配置即可运行。
