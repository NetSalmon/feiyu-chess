/*
 * 肥鱼 CHESS
 * Copyright (C) 2026 NetSalmon
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { Chess } from "chess.js";
import { EventEmitter } from "node:events";

export const MOVE_TOOL = {
  type: "function",
  function: {
    name: "make_move",
    description:
      "Play exactly one legal chess move in UCI notation, e.g. e2e4, e1g1 (castling), or e7e8q (promotion).",
    parameters: {
      type: "object",
      properties: {
        move: {
          type: "string",
          description: "A legal UCI move from the supplied legal_moves list.",
        },
      },
      required: ["move"],
      additionalProperties: false,
    },
  },
};

export function normalizePlayer(input, color, demo = false) {
  if (!input || typeof input !== "object")
    throw new Error("请填写双方模型配置");
  const name = String(input.name || (color === "w" ? "白方 AI" : "黑方 AI"))
    .trim()
    .slice(0, 80);
  const model = String(input.model || "").trim();
  const apiKey = String(input.apiKey || "").trim();
  const systemPrompt = String(input.systemPrompt || "").slice(0, 16000);
  const reasoningEffort = input.reasoningEffort ?? "auto";
  if (!["none", "auto", "low", "medium", "high"].includes(reasoningEffort))
    throw new Error(`${name}：思考强度须为 none、auto、low、medium 或 high`);
  const avatar = input.avatar ?? "";
  if (
    typeof avatar !== "string" ||
    avatar.length > 64000 ||
    (avatar &&
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
        avatar,
      ))
  )
    throw new Error(`${name}：头像须为 64KB 以内的 PNG、JPEG 或 WebP 图片数据`);
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : "";
  if (!demo) {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(`${name}：请输入有效的完整 API 请求 URL`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error(`${name}：API 地址须为不含内嵌账号密码的 HTTP(S) 地址`);
    }
    if (!model || model.length > 200)
      throw new Error(`${name}：请填写模型名称（最多 200 字符）`);
    if (apiKey.length > 4096 || /[\r\n]/.test(apiKey))
      throw new Error(`${name}：API Key 格式无效`);
  }
  return {
    name,
    model: demo ? "本地演示 · 无 API 消耗" : model,
    apiKey,
    baseUrl,
    systemPrompt,
    avatar,
    reasoningEffort,
  };
}

export function gameResult(chess) {
  if (chess.isCheckmate())
    return {
      winner: chess.turn() === "w" ? "b" : "w",
      reason: "将死",
      score: chess.turn() === "w" ? "0-1" : "1-0",
    };
  let reason;
  if (chess.isStalemate()) reason = "逼和";
  else if (chess.isThreefoldRepetition()) reason = "三次重复局面";
  else if (chess.isInsufficientMaterial()) reason = "子力不足";
  else if (chess.isDrawByFiftyMoves()) reason = "五十回合规则";
  else if (chess.isDraw()) reason = "和棋";
  return reason ? { winner: null, reason, score: "1/2-1/2" } : null;
}

export class Match extends EventEmitter {
  constructor(
    {
      white,
      black,
      demo = false,
      delayMs = 500,
      timeoutMs = 60000,
      maxPlies = 400,
    },
    { fetchImpl = fetch, chess = new Chess() } = {},
  ) {
    super();
    if (typeof demo !== "boolean") throw new Error("演示模式参数须为布尔值");
    this.players = {
      w: normalizePlayer(white, "w", demo),
      b: normalizePlayer(black, "b", demo),
    };
    this.demo = demo === true;
    this.delayMs = bounded(delayMs, 0, 5000, "落子间隔");
    this.timeoutMs = bounded(timeoutMs, 1000, 3600000, "请求超时");
    this.maxPlies = bounded(maxPlies, 4, 2000, "最大半回合数");
    this.fetchImpl = fetchImpl;
    this.chess = chess;
    this.status = "ready";
    this.result = null;
    this.moves = [];
    this.logs = [];
    this.messages = { w: [], b: [] };
    this.messageSequence = 0;
    this.thinking = null;
    this.generation = 0;
    this.revision = 0;
    this.histories = { w: [], b: [] };
    this.interviews = {
      w: { status: "waiting", text: "", error: null },
      b: { status: "waiting", text: "", error: null },
    };
    this.interviewControllers = {};
    this.interviewGeneration = 0;
    this.lastTouched = Date.now();
    this.createdAt = this.lastTouched;
    this.needsConfiguration = false;
    this.persistenceError = null;
    this.chess.header(
      "Event",
      "肥鱼 AI Chess",
      "White",
      this.players.w.name,
      "Black",
      this.players.b.name,
      "Result",
      "*",
    );
  }

  snapshot() {
    return {
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.lastTouched,
      needsConfiguration: this.needsConfiguration,
      persistenceError: this.persistenceError,
      revision: this.revision,
      fen: this.chess.fen(),
      board: this.chess.board(),
      turn: this.chess.turn(),
      check: this.chess.isCheck(),
      result: this.result,
      moves: this.moves,
      logs: this.logs,
      thinking: this.thinking,
      demo: this.demo,
      maxPlies: this.maxPlies,
      timeoutMs: this.timeoutMs,
      messages: this.messages,
      interviews: this.interviews,
      players: Object.fromEntries(
        Object.entries(this.players).map(([color, p]) => [
          color,
          {
            name: p.name,
            model: p.model,
            avatar: p.avatar,
            systemPrompt: p.systemPrompt,
            reasoningEffort: p.reasoningEffort,
          },
        ]),
      ),
    };
  }

  toRecord() {
    return {
      version: 1,
      players: this.snapshot().players,
      demo: this.demo,
      delayMs: this.delayMs,
      timeoutMs: this.timeoutMs,
      maxPlies: this.maxPlies,
      pgn: this.pgn(),
      status: this.status,
      result: this.result,
      moves: this.moves,
      logs: this.logs,
      messages: this.messages,
      messageSequence: this.messageSequence,
      histories: this.histories,
      interviews: this.interviews,
      createdAt: this.createdAt,
      updatedAt: this.lastTouched,
      revision: this.revision,
    };
  }

  static fromRecord(record, dependencies = {}) {
    if (record.version !== 1) throw new Error("不支持的对局存档版本");
    const chess = new Chess();
    chess.loadPgn(record.pgn);
    const headers = chess.getHeaders();
    const match = new Match(
      {
        ...record,
        white: {
          ...record.players.w,
          baseUrl: "http://restore.invalid",
          apiKey: "",
        },
        black: {
          ...record.players.b,
          baseUrl: "http://restore.invalid",
          apiKey: "",
        },
      },
      { ...dependencies, chess },
    );
    for (const color of ["w", "b"]) match.players[color].baseUrl = "";
    match.chess.header(...Object.entries(headers).flat());
    match.status = ["ready", "running"].includes(record.status)
      ? "paused"
      : record.status;
    match.result = record.result;
    match.moves = record.moves;
    match.logs = record.logs;
    match.messages = record.messages;
    match.messageSequence = record.messageSequence;
    match.histories = record.histories;
    match.interviews = record.interviews;
    for (const color of ["w", "b"]) {
      if (
        match.result &&
        ["waiting", "running"].includes(match.interviews[color].status)
      )
        match.interviews[color] = {
          status: "error",
          text: "",
          error: "服务重启中断了采访，可重新采访。",
        };
    }
    match.createdAt = record.createdAt;
    match.lastTouched = record.updatedAt;
    match.revision = record.revision + 1;
    match.needsConfiguration = !match.demo;
    if (["ready", "running"].includes(record.status))
      match.log("已从服务器存档恢复。补回 API 配置后可继续对局。");
    return match;
  }

  publish() {
    this.revision++;
    this.lastTouched = Date.now();
    this.emit("state", this.snapshot());
  }
  log(message, kind = "info") {
    this.logs.push({ time: new Date().toISOString(), message, kind });
    this.logs = this.logs.slice(-150);
  }

  updateTimeout(timeoutMs) {
    this.timeoutMs = bounded(timeoutMs, 1000, 3600000, "请求超时");
    this.log(`请求超时已改为 ${this.timeoutMs / 1000} 秒，将用于后续请求`);
    this.publish();
  }

  recordMessage(color, content, phase = "move") {
    if (typeof content !== "string" || !content.trim()) return;
    this.messages[color].push({
      id: ++this.messageSequence,
      time: new Date().toISOString(),
      text: content.trim().slice(0, 16000),
      phase,
      ply: this.moves.length + (phase === "move" ? 1 : 0),
    });
    this.messages[color] = this.messages[color].slice(-200);
    this.publish();
  }

  start() {
    if (!["ready", "paused"].includes(this.status))
      throw new Error("当前对局无法开始");
    if (this.needsConfiguration)
      throw new Error("请先补回双方 API 配置，再继续对局");
    this.status = "running";
    this.log(this.moves.length ? "对局已继续" : "对局开始，白方先行");
    const generation = ++this.generation;
    this.publish();
    // Each run owns a generation. An aborted response can never mutate a resumed game.
    void this.run(generation).catch(() => {
      if (generation !== this.generation) return;
      this.status = "paused";
      this.thinking = null;
      this.log("对局运行异常，已暂停。可尝试继续。", "error");
      this.publish();
    });
  }

  pause() {
    if (this.status !== "running") throw new Error("当前对局未在运行");
    this.generation++;
    this.controller?.abort();
    this.status = "paused";
    this.thinking = null;
    this.log("对局已暂停");
    this.publish();
  }

  stop() {
    this.generation++;
    this.controller?.abort();
    this.interviewGeneration++;
    for (const [color, controller] of Object.entries(
      this.interviewControllers,
    )) {
      controller.abort();
      if (this.interviews[color].status === "running") {
        this.interviews[color] = {
          status: "error",
          text: "",
          error: "采访已中断，可重新采访。",
        };
      }
    }
    this.thinking = null;
    if (!this.result) {
      this.status = "stopped";
      this.log("对局已结束，未判定胜负");
    }
    this.publish();
  }

  updatePlayers({ white, black }) {
    if (
      this.status !== "paused" &&
      !(this.status === "finished" && this.needsConfiguration)
    )
      throw new Error("请先暂停对局，再更新模型配置");
    const players = {
      w: normalizePlayer(white, "w", this.demo),
      b: normalizePlayer(black, "b", this.demo),
    };
    this.players = players;
    this.needsConfiguration = false;
    this.chess.header("White", players.w.name, "Black", players.b.name);
    this.log("双方模型配置已更新");
    this.publish();
  }

  finish(result) {
    this.result = result;
    this.status = "finished";
    this.thinking = null;
    this.chess.header("Result", result.score, "Termination", result.reason);
    this.log(
      `${result.winner ? (result.winner === "w" ? "白方" : "黑方") + "获胜" : "和棋"}：${result.reason}`,
      "result",
    );
    this.publish();
    this.startInterviews();
  }

  async run(generation) {
    while (this.status === "running" && generation === this.generation) {
      const result = gameResult(this.chess);
      if (result) {
        this.finish(result);
        return;
      }
      if (this.moves.length >= this.maxPlies) {
        this.finish({
          winner: null,
          score: "1/2-1/2",
          reason: "达到配置的半回合上限（程序裁定和棋）",
        });
        return;
      }
      const color = this.chess.turn();
      this.thinking = color;
      this.log(`${color === "w" ? "白方" : "黑方"}正在思考…`);
      this.publish();
      let outcome;
      const started = Date.now();
      try {
        outcome = await this.requestMove(color, generation);
      } catch (error) {
        if (generation !== this.generation) return;
        this.status = "paused";
        this.thinking = null;
        this.log(error.message, "error");
        this.publish();
        return;
      }
      if (generation !== this.generation || this.status !== "running") return;
      this.thinking = null;
      if (!outcome) {
        const winner = color === "w" ? "b" : "w";
        this.finish({
          winner,
          score: winner === "w" ? "1-0" : "0-1",
          reason: `${color === "w" ? "白方" : "黑方"}连续 3 次未提交合法落子，判负`,
        });
        return;
      }
      const move = this.chess.move(outcome);
      if (outcome.conversation) {
        const { messages, assistant, callId } = outcome.conversation;
        this.histories[color] = [
          ...messages,
          assistant,
          {
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify({
              ok: true,
              move: move.from + move.to + (move.promotion || ""),
              san: move.san,
              fen: this.chess.fen(),
            }),
          },
        ];
      }
      this.moves.push({
        color,
        san: move.san,
        uci: move.from + move.to + (move.promotion || ""),
        from: move.from,
        to: move.to,
        fen: this.chess.fen(),
        elapsedMs: Date.now() - started,
      });
      this.log(
        `${color === "w" ? "白方" : "黑方"}落子 ${move.san} · ${move.from} → ${move.to}`,
        "move",
      );
      const after = gameResult(this.chess);
      if (after) {
        this.finish(after);
        return;
      }
      this.publish();
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }

  async requestMove(color, generation) {
    if (this.demo) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (generation !== this.generation) throw new Error("对局已暂停");
      this.recordMessage(
        color,
        [
          "先走 f3，试着打开局面。",
          "我用 e5 控制中心，留意白方王翼。",
          "继续推进 g4，尝试争取王翼空间。",
          "王翼出现了空隙，Qh4 将军！",
        ][this.moves.length],
      );
      const move = ["f2f3", "e7e5", "g2g4", "d8h4"][this.moves.length];
      return { from: move.slice(0, 2), to: move.slice(2, 4) };
    }
    const player = this.players[color];
    const legalMoves = this.chess
      .moves({ verbose: true })
      .map((m) => m.from + m.to + (m.promotion || ""));
    const messages = [
      {
        role: "system",
        content: `${player.systemPrompt}\n\nYou play ${color === "w" ? "WHITE" : "BLACK"} in a chess game. Call make_move exactly once to play your turn. Use only a UCI move from legal_moves. The referee enforces all rules. Board coordinates: a1 is White's lower-left corner. Select the strongest move you can.`,
      },
      ...this.histories[color].slice(1),
      {
        role: "user",
        content: JSON.stringify({
          fen: this.chess.fen(),
          board: this.chess.ascii(),
          pgn: this.chess.pgn(),
          legal_moves: legalMoves,
          in_check: this.chess.isCheck(),
        }),
      },
    ];
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (generation !== this.generation) throw new Error("对局已暂停");
      const controller = new AbortController();
      this.controller = controller;
      const timeoutMs = this.timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let message;
      try {
        const response = await this.fetchImpl(player.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(player.apiKey
              ? { Authorization: `Bearer ${player.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: player.model,
            messages,
            tools: [MOVE_TOOL],
            tool_choice: "auto",
            stream: false,
            ...completionOptions(player),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw await providerError(response, Object.values(this.players));
        }
        const data = await response.json();
        message = data?.choices?.[0]?.message;
      } catch (error) {
        if (controller.signal.aborted)
          throw new Error(
            `API 请求超时（${timeoutMs / 1000} 秒），对局已暂停，可继续重试。`,
          );
        if (error.message.startsWith("API 返回")) throw error;
        throw new Error(
          "无法连接 API 或响应不是有效 JSON。对局已暂停，请检查服务配置后继续。",
        );
      } finally {
        clearTimeout(timer);
        if (this.controller === controller) this.controller = null;
      }
      if (generation !== this.generation) throw new Error("对局已暂停");
      this.recordMessage(color, message?.content);
      const calls = message?.tool_calls;
      let feedback =
        'Call make_move exactly once with JSON arguments {"move":"e2e4"}. Choose a move from legal_moves.';
      if (
        Array.isArray(calls) &&
        calls.length === 1 &&
        typeof calls[0]?.id === "string" &&
        calls[0].id.length > 0 &&
        calls[0]?.function?.name === "make_move"
      ) {
        try {
          const args = JSON.parse(calls[0].function.arguments);
          const uci = args.move;
          if (typeof uci === "string" && legalMoves.includes(uci)) {
            return {
              from: uci.slice(0, 2),
              to: uci.slice(2, 4),
              ...(uci[4] ? { promotion: uci[4] } : {}),
              conversation: {
                messages,
                assistant: assistantMessage(message),
                callId: calls[0].id,
              },
            };
          }
          feedback = `Illegal move. Select one of legal_moves: ${legalMoves.join(", ")}.`;
        } catch {
          feedback =
            'Invalid JSON arguments. Provide {"move":"<legal UCI move>"}.';
        }
      }
      // Return tool results for every call so retries remain valid Chat Completions conversations.
      if (
        Array.isArray(calls) &&
        calls.length &&
        calls.every(
          (c) =>
            typeof c.id === "string" &&
            typeof c.function?.name === "string" &&
            typeof c.function?.arguments === "string",
        )
      ) {
        messages.push(assistantMessage(message));
        for (const call of calls)
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ ok: false, error: feedback }),
          });
      } else if (
        (typeof message?.content === "string" && message.content) ||
        typeof message?.reasoning_content === "string"
      ) {
        messages.push(assistantMessage(message));
      }
      messages.push({ role: "user", content: feedback });
      this.log(
        `未收到合法落子（${attempt}/3）${attempt < 3 ? "，正在要求模型重试" : ""}`,
        "warning",
      );
      this.publish();
    }
    this.histories[color] = messages;
    return null;
  }

  startInterviews() {
    if (!this.result) throw new Error("棋局结束后才能进行赛后采访");
    if (this.needsConfiguration)
      throw new Error("请先补回双方 API 配置，再重试采访");
    const generation = this.interviewGeneration;
    for (const color of ["w", "b"]) {
      if (!["waiting", "error"].includes(this.interviews[color].status))
        continue;
      this.interviews[color] = { status: "running", text: "", error: null };
      void this.requestInterview(color, generation);
    }
    this.publish();
  }

  async requestInterview(color, generation) {
    const player = this.players[color];
    const side = color === "w" ? "白方" : "黑方";
    const controller = new AbortController();
    this.interviewControllers[color] = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let text;
      if (this.demo) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        text =
          color === "w"
            ? "这盘失利让我印象深刻。我连续走了 f3 和 g4，削弱了王翼，给了黑后 Qh4# 的机会。输得很快，也让我重新认识到开局王的安全有多重要。下次我会先控制中心、发展子力，更仔细地检查对手的将军威胁。"
            : "能够抓住这次机会，我感到很满意。白方 f3、g4 后暴露了王翼，我用 Qh4# 结束了对局。这盘棋提醒我，战术机会往往来自对手留下的弱点。接下来我仍会保持耐心，在把握进攻机会的同时做好自身布局。";
      } else {
        const history = this.histories[color];
        const messages = [
          ...(history.length
            ? history
            : [
                {
                  role: "system",
                  content: `${player.systemPrompt}\n你是本局${side}棋手。`,
                },
              ]),
          {
            role: "system",
            content:
              "棋局已结束，现在进入肥鱼 CHESS 的赛后采访。此前的走棋指令已结束，不再调用任何工具。保持你的棋手身份和此前对话上下文，用 100–200 字中文回答感受与复盘，结合实际棋谱，不要编造未发生的落子。",
          },
          {
            role: "user",
            content: JSON.stringify({
              phase: "post_match_interview",
              your_color: color,
              your_result:
                this.result.winner === color
                  ? "win"
                  : this.result.winner
                    ? "loss"
                    : "draw",
              result: this.result,
              final_fen: this.chess.fen(),
              pgn: this.chess.pgn(),
              opponent: this.players[color === "w" ? "b" : "w"].name,
              questions: [
                "这场对战给你带来了怎样的感受？",
                "你如何看待本局的胜负或和棋结果？",
                "你最想复盘哪一步，下一场准备如何调整？",
              ],
            }),
          },
        ];
        const response = await this.fetchImpl(player.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(player.apiKey
              ? { Authorization: `Bearer ${player.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: player.model,
            messages,
            stream: false,
            ...completionOptions(player),
          }),
          signal: controller.signal,
        });
        if (!response.ok)
          throw await providerError(
            response,
            Object.values(this.players),
            true,
          );
        const data = await response.json();
        text = data?.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim())
          throw new Error("模型未返回采访文字，可重试。");
        text = text.trim().slice(0, 16000);
        if (generation === this.interviewGeneration)
          this.histories[color] = [
            ...messages,
            { role: "assistant", content: text },
          ];
      }
      if (generation !== this.interviewGeneration) return;
      this.interviews[color] = { status: "completed", text, error: null };
      this.recordMessage(color, text, "interview");
      this.log(`${side}赛后采访已完成`);
    } catch (error) {
      if (generation !== this.interviewGeneration) return;
      const message = controller.signal.aborted
        ? "采访请求超时，可重试。"
        : /^采访 API|^模型未返回/.test(error.message)
          ? error.message
          : "采访连接失败或响应无效，可重试。";
      this.interviews[color] = { status: "error", text: "", error: message };
      this.log(`${side}${message}`, "warning");
    } finally {
      clearTimeout(timer);
      if (this.interviewControllers[color] === controller)
        delete this.interviewControllers[color];
      if (generation === this.interviewGeneration) this.publish();
    }
  }

  pgn() {
    return this.chess.pgn();
  }
}

function assistantMessage(message) {
  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : null,
    ...(typeof message.reasoning_content === "string"
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(Array.isArray(message.tool_calls) && message.tool_calls.length
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.function.name,
              arguments: call.function.arguments,
            },
          })),
        }
      : {}),
  };
}

function completionOptions(player) {
  // DeepSeek uses its own thinking switch alongside the OpenAI-compatible effort.
  const deepseek =
    /^deepseek(?:-|$)/i.test(player.model) ||
    new URL(player.baseUrl).hostname === "api.deepseek.com";
  return {
    ...(deepseek
      ? {
          thinking: {
            type: player.reasoningEffort === "none" ? "disabled" : "enabled",
          },
        }
      : {}),
    ...(player.reasoningEffort !== "auto" &&
    !(deepseek && player.reasoningEffort === "none")
      ? { reasoning_effort: player.reasoningEffort }
      : {}),
  };
}

async function providerError(response, players, interview = false) {
  let detail = "";
  try {
    const data = await response.json();
    const message = data?.error?.message ?? data?.message;
    if (typeof message === "string") {
      detail = message;
      // Expose only the structured error message, never raw response bodies or credentials.
      for (const player of players) {
        if (player.apiKey) {
          for (const secret of [
            player.apiKey,
            encodeURIComponent(player.apiKey),
            JSON.stringify(player.apiKey).slice(1, -1),
          ])
            detail = detail.replaceAll(secret, "[REDACTED]");
        }
        if (player.baseUrl)
          detail = detail.replaceAll(player.baseUrl, "[API URL]");
      }
      detail = detail
        .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
        .replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [REDACTED]")
        .replace(
          /([?&](?:api[-_]?key|token|access_token|key|signature)=)[^&\s"'<>]*/gi,
          "$1[REDACTED]",
        )
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 1200);
    }
  } catch {
    /* Non-JSON bodies may contain HTML or secrets; do not reflect them. */
  }
  const prefix = interview ? "采访 API 返回" : "API 返回";
  return new Error(
    `${prefix} HTTP ${response.status}${detail ? `：${detail}` : "。请检查地址、Key、模型名称及服务支持。"}${interview ? "（可重试）" : ""}`,
  );
}

function bounded(value, min, max, label) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${label}须为 ${min}–${max} 之间的整数`);
  return value;
}
