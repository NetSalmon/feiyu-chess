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

import {
  loadPreferences,
  savePreferences,
  loadGameId,
  saveGameId,
} from "./preferences.js";

const $ = (selector) => document.querySelector(selector);
const form = $("#settings-form");
const initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const efforts = ["none", "auto", "low", "medium", "high"];
const effortLabels = ["关闭", "自动", "轻量", "均衡", "深入"];
const sides = [
  ["white", "w"],
  ["black", "b"],
];
const symbols = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
let state = null;
const browserStorage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
let savedSettings = loadPreferences(browserStorage);
let gameId = loadGameId(browserStorage);
// Preserve an open game from versions that only used sessionStorage.
if (!gameId) {
  try {
    gameId = loadGameId(window.sessionStorage);
    if (gameId) {
      saveGameId(browserStorage, gameId);
      saveGameId(window.sessionStorage, null);
    }
  } catch {}
}
let stream;
let flipped = false;
let busy = false;
let toastTimer;
let lastMoveCount = -1;
let saveTimer;

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      node.hidden = true;
    },
    error ? 7000 : 3000,
  );
}

async function api(path, body, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok)
    throw new Error(data?.error || `请求失败（${response.status}）`);
  return data;
}

function acceptState(next) {
  // A fast SSE update can arrive before the response to the action that triggered it.
  if (!state || (next.revision ?? 0) >= (state.revision ?? 0)) state = next;
}

function settings() {
  const values = { get: (name) => form.elements[name].value };
  const player = (side) =>
    Object.fromEntries(
      ["name", "model", "baseUrl", "apiKey", "systemPrompt", "avatar"].map(
        (key) => [key, values.get(`${side}-${key}`)],
      ),
    );
  return {
    white: {
      ...player("white"),
      reasoningEffort: efforts[Number(values.get("white-reasoningEffort"))],
    },
    black: {
      ...player("black"),
      reasoningEffort: efforts[Number(values.get("black-reasoningEffort"))],
    },
    delayMs: Number(values.get("delayMs")),
    timeoutMs: Number(values.get("timeoutSeconds")) * 1000,
    maxPlies: Number(values.get("maxPlies")),
  };
}

function persistSettings() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const config = settings();
  const saved = savePreferences(browserStorage, config);
  if (saved) savedSettings = config;
  $("#preferences-note").textContent = saved
    ? "双方设置（含 API Key）已自动保存在当前浏览器。"
    : "浏览器未能保存设置，请检查存储权限或可用空间。";
}

function restoreSettings() {
  if (!savedSettings) return;
  for (const [side] of sides) {
    const player = savedSettings[side];
    for (const key of [
      "name",
      "model",
      "baseUrl",
      "apiKey",
      "systemPrompt",
      "avatar",
    ])
      if (typeof player?.[key] === "string")
        form.elements[`${side}-${key}`].value = player[key];
    const level = efforts.indexOf(player?.reasoningEffort);
    if (level >= 0)
      form.elements[`${side}-reasoningEffort`].value = String(level);
  }
  for (const [field, value] of [
    ["delayMs", savedSettings.delayMs],
    ["maxPlies", savedSettings.maxPlies],
    ["timeoutSeconds", savedSettings.timeoutMs / 1000],
  ])
    if (Number.isFinite(value)) form.elements[field].value = String(value);
}

async function refreshHistory() {
  const games = await api("/api/games", undefined, "GET");
  const select = $("#history-select");
  const selected = select.value || gameId;
  const fragment = document.createDocumentFragment();
  if (!games.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "暂无服务器对局记录";
    fragment.append(empty);
  }
  const labels = {
    ready: "准备中",
    running: "对弈中",
    paused: "已暂停",
    finished: "已结束",
    stopped: "已终止",
  };
  for (const game of games) {
    const option = document.createElement("option");
    option.value = game.id;
    option.textContent = `${new Date(game.createdAt).toLocaleString("zh-CN", { hour12: false })} · ${game.white} vs ${game.black} · ${game.result?.score || labels[game.status]} · ${game.moves} 步`;
    fragment.append(option);
  }
  select.replaceChildren(fragment);
  if (games.some((game) => game.id === selected)) select.value = selected;
  $("#open-history").disabled = busy || !games.length;
}

async function openMatch(id) {
  const next = await api(`/api/games/${id}`, undefined, "GET");
  stream?.close();
  gameId = id;
  state = next;
  lastMoveCount = -1;
  saveGameId(browserStorage, id);
  hydrateProfiles();
  render();
  connect();
}

function drawBoard() {
  const fen = state?.fen || initialFen;
  const position = new Map();
  fen
    .split(" ")[0]
    .split("/")
    .forEach((row, i) => {
      let file = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) {
          file += Number(ch);
          continue;
        }
        position.set("abcdefgh"[file++] + (8 - i), {
          type: ch.toLowerCase(),
          color: ch === ch.toUpperCase() ? "w" : "b",
        });
      }
    });
  const last = state?.moves.at(-1);
  const fragment = document.createDocumentFragment();
  const rows = flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = flipped ? "hgfedcba" : "abcdefgh";
  rows.forEach((rank, row) =>
    [...files].forEach((file, col) => {
      const square = file + rank;
      const piece = position.get(square);
      const cell = document.createElement("div");
      cell.className = "square";
      cell.classList.toggle("dark", (file.charCodeAt(0) - 97 + rank) % 2 === 1);
      cell.classList.toggle(
        "last",
        square === last?.from || square === last?.to,
      );
      cell.classList.toggle(
        "in-check",
        !!(state?.check && piece?.type === "k" && piece.color === state.turn),
      );
      cell.dataset.square = square;
      if (piece) {
        const icon = document.createElement("span");
        icon.className = `piece ${piece.color}`;
        icon.textContent = symbols[piece.type];
        cell.append(icon);
      }
      if (col === 0) {
        const label = document.createElement("span");
        label.className = "coordinate rank";
        label.textContent = rank;
        cell.append(label);
      }
      if (row === 7) {
        const label = document.createElement("span");
        label.className = "coordinate file";
        label.textContent = file;
        cell.append(label);
      }
      fragment.append(cell);
    }),
  );
  $("#board").replaceChildren(fragment);
  $("#board").setAttribute(
    "aria-label",
    `国际象棋棋盘，${flipped ? "黑方" : "白方"}在下。${state?.check ? "当前被将军。" : ""}局面 FEN：${fen}`,
  );
  $("#fen").textContent = fen;
}

function render() {
  drawBoard();
  const active = state?.status === "running";
  const paused = state?.status === "paused";
  const ended = ["finished", "stopped"].includes(state?.status);
  const statusNames = {
    running: "对弈中",
    paused: "已暂停",
    finished: "已结束",
    stopped: "已终止",
    ready: "准备就绪",
  };
  const turnName = state?.turn === "b" ? "黑方" : "白方";
  $("#board-status").textContent = active
    ? `${turnName}${state.thinking ? "正在思考" : "即将落子"}${state.check ? " · 将军" : ""}`
    : paused
      ? `${turnName}回合 · 已暂停`
      : state?.result
        ? `${state.result.winner ? (state.result.winner === "w" ? "白方" : "黑方") + "获胜" : "和棋"} · ${state.result.score}`
        : state?.status === "stopped"
          ? "对局已终止"
          : "等待开局";
  $("#turn-dot").classList.toggle("live", active);
  $("#move-count").textContent = state?.moves.length || 0;
  $("#match-status").textContent = state ? statusNames[state.status] : "未开始";
  $("#match-title").textContent = state?.result
    ? state.result.winner
      ? `${state.result.winner === "w" ? "白方" : "黑方"}，赢下此局。`
      : "势均力敌，握手言和。"
    : active
      ? `${turnName}的回合。`
      : paused
        ? "稍作停顿，再续博弈。"
        : ended
          ? "这一局，暂告段落。"
          : "棋局，蓄势待发。";
  $("#match-subtitle").textContent = state
    ? state.result?.reason ||
      (state.demo
        ? "本地演示 · 愚人将杀 · 无需 API Key"
        : `${state.moves.length} 个半回合 / 上限 ${state.maxPlies} · 自动交替落子`)
    : "配置双方模型，开始第一步。";
  for (const [side, color] of sides) {
    renderProfile(side);
    $(`#${side}-player`).classList.toggle(
      "active",
      active && state?.turn === color,
    );
    $(`#${side}-status`).textContent = ended
      ? state.result?.winner === color
        ? "获胜"
        : state.result?.winner
          ? "落败"
          : state.result
            ? "和棋"
            : "已终止"
      : active && state.turn === color
        ? state.thinking
          ? "思考中…"
          : "准备落子"
        : paused && state.turn === color
          ? "已暂停"
          : state
            ? "等待"
            : color === "w"
              ? "先手"
              : "后手";
  }
  $("#pause").disabled = busy || !(active || paused);
  $("#pause").textContent = paused ? "▶ 继续对局" : "Ⅱ 暂停对局";
  $("#stop").disabled = busy || !(active || paused);
  $("#stop").hidden = ended;
  $("#pause").hidden = ended;
  $("#new-game").hidden = !ended;
  $("#start").disabled = busy || active || paused;
  $("#start").textContent = active
    ? "对局进行中"
    : paused
      ? "对局已暂停"
      : ended
        ? "使用当前配置再开一局 ↗"
        : "开始对弈 ↗";
  $("#demo").disabled = busy || active || paused;
  $("#save-config").hidden = !paused || state.demo;
  $("#save-config").disabled = busy;
  $("#export").disabled = !gameId;
  // Timeout can be applied to subsequent requests while a match is running.
  for (const input of form.querySelectorAll(
    "input,textarea,[data-upload],[data-reset],[data-edit],[data-apply]",
  ))
    input.disabled =
      input.name !== "timeoutSeconds" &&
      (active || (paused && ["delayMs", "maxPlies"].includes(input.name)));
  renderTimeout();
  $("#copy-config").disabled = active;
  $("#result").hidden = !state?.result;
  if (state?.result) {
    const title = document.createElement("strong");
    title.textContent = `${state.result.winner ? (state.result.winner === "w" ? "白方" : "黑方") + "获胜" : "和棋"}  ${state.result.score}`;
    const detail = document.createElement("small");
    detail.textContent = state.result.reason;
    const interviewLink = document.createElement("button");
    interviewLink.type = "button";
    interviewLink.className = "text-button interview-link";
    interviewLink.textContent = "查看赛后采访 ↓";
    interviewLink.addEventListener("click", () =>
      $("#interviews").scrollIntoView({ behavior: "smooth", block: "start" }),
    );
    $("#result").replaceChildren(title, detail, interviewLink);
  }
  renderMoves();
  renderLogs();
  renderInterviews();
  renderMessages();
  $("#server-storage-note").textContent =
    state?.persistenceError ||
    (state?.needsConfiguration && (paused || state?.result)
      ? "对局已从服务器恢复；继续或重试采访时将补回浏览器中的 API 配置。"
      : "对局自动保存在服务器，重启后可从历史记录恢复。");
  $("#server-storage-note").classList.toggle(
    "storage-error",
    !!state?.persistenceError,
  );
  $("#open-history").disabled = busy || !$("#history-select").value;
  $("#refresh-history").disabled = busy;
}

function renderTimeout() {
  const input = form.elements.timeoutSeconds;
  const button = $("#apply-timeout");
  button.hidden = !state;
  button.disabled =
    busy ||
    !input.validity.valid ||
    Number(input.value) * 1000 === state?.timeoutMs;
  $("#timeout-hint").textContent = state
    ? `当前 ${state.timeoutMs / 1000} 秒。修改后点击应用；正在进行的请求仍使用原时限。`
    : "1–3600 秒，适用于每次走棋与赛后采访请求。";
}

function renderMessages() {
  for (const [side, color] of sides) {
    const node = $(`#${side}-messages`);
    const messages = state?.messages?.[color] || [];
    const signature = `${gameId || ""}:${messages.at(-1)?.id || 0}`;
    if (node.dataset.signature === signature) continue;
    const fragment = document.createDocumentFragment();
    if (!messages.length) {
      const empty = document.createElement("p");
      empty.className = "speech-empty";
      empty.textContent = "等待棋手发言…";
      fragment.append(empty);
    }
    for (const message of [...messages].reverse()) {
      const bubble = document.createElement("article");
      bubble.className = "output-bubble";
      const meta = document.createElement("div");
      meta.className = "output-meta";
      const phase = document.createElement("span");
      phase.textContent = `${state.demo ? "演示 · " : ""}${message.phase === "interview" ? "赛后采访" : `第 ${message.ply} 步`}`;
      const time = document.createElement("time");
      time.dateTime = message.time;
      time.textContent = new Date(message.time).toLocaleTimeString("zh-CN", {
        hour12: false,
      });
      meta.append(phase, time);
      const text = document.createElement("p");
      text.textContent = message.text;
      bubble.append(meta, text);
      fragment.append(bubble);
    }
    node.replaceChildren(fragment);
    node.dataset.signature = signature;
    node.scrollTop = 0;
  }
}

function renderInterviews() {
  const section = $("#interviews");
  section.hidden = !state?.result;
  if (!state?.result) return;
  const labels = {
    waiting: "等待采访",
    running: "正在采访…",
    completed: "采访完成",
    error: "采访未完成",
  };
  let hasErrors = false;
  let pending = false;
  for (const [side, color] of sides) {
    const interview = state.interviews?.[color] || { status: "waiting" };
    const player = state.players[color];
    $(`#${side}-interview-name`).textContent = player.name;
    $(`#${side}-interview-status`).textContent = labels[interview.status];
    const text = $(`#${side}-interview-text`);
    text.textContent =
      interview.status === "completed"
        ? interview.text
        : interview.status === "error"
          ? interview.error
          : "正在回顾整场对局，整理赛后感受…";
    text.classList.toggle(
      "pending",
      ["waiting", "running"].includes(interview.status),
    );
    text.classList.toggle("error", interview.status === "error");
    const avatar = $(`#${side}-interview-avatar`);
    const src = player.avatar || "";
    if (avatar.dataset.source !== src) {
      if (src) {
        const image = document.createElement("img");
        image.src = src;
        image.alt = `${player.name}头像`;
        avatar.replaceChildren(image);
      } else avatar.textContent = side === "white" ? "♔" : "♚";
      avatar.dataset.source = src;
    }
    hasErrors ||= interview.status === "error";
    pending ||= interview.status === "running";
  }
  $("#retry-interviews").hidden = !hasErrors;
  $("#retry-interviews").disabled = busy || pending;
  $("#interview-note").textContent = state.demo
    ? "本地演示采访 · 示例感言，不调用真实 API。"
    : "采访使用双方原有模型与对局上下文，在赛后各发起一次请求。";
}

function renderMoves() {
  const moves = state?.moves || [];
  if (!moves.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElement("span");
    icon.textContent = "♙";
    const title = document.createElement("p");
    title.textContent = "棋盘已就绪";
    const detail = document.createElement("small");
    detail.textContent = "第一步，交给 AI。";
    empty.append(icon, title, detail);
    $("#moves").replaceChildren(empty);
    lastMoveCount = moves.length;
    return;
  }
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < moves.length; i += 2) {
    const row = document.createElement("div");
    row.className = "move-row";
    const n = document.createElement("span");
    n.textContent = String(i / 2 + 1).padStart(2, "0");
    row.append(n);
    for (const index of [i, i + 1]) {
      const cell = document.createElement("span");
      if (moves[index]) {
        cell.textContent = moves[index].san;
        cell.title = `${moves[index].uci} · ${(moves[index].elapsedMs / 1000).toFixed(1)} 秒`;
        if (index === moves.length - 1) cell.className = "latest";
        const elapsed = document.createElement("small");
        elapsed.textContent = `${(moves[index].elapsedMs / 1000).toFixed(1)}s`;
        cell.append(elapsed);
      } else cell.textContent = "—";
      row.append(cell);
    }
    fragment.append(row);
  }
  $("#moves").replaceChildren(fragment);
  if (lastMoveCount !== moves.length)
    $("#moves").scrollTop = $("#moves").scrollHeight;
  lastMoveCount = moves.length;
}

function renderLogs() {
  if (!state?.logs.length) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = "开局后，落子与运行状态将在这里显示。";
    $("#activity").replaceChildren(empty);
    return;
  }
  const node = $("#activity");
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  const fragment = document.createDocumentFragment();
  for (const log of state.logs) {
    const row = document.createElement("div");
    row.className = `activity-line ${log.kind}`;
    const time = document.createElement("time");
    time.dateTime = log.time;
    time.textContent = new Date(log.time).toLocaleTimeString("zh-CN", {
      hour12: false,
    });
    const message = document.createElement("span");
    message.textContent = log.message;
    row.append(time, message);
    fragment.append(row);
  }
  node.replaceChildren(fragment);
  if (atBottom) node.scrollTop = node.scrollHeight;
}

function connect() {
  stream?.close();
  const id = gameId;
  stream = new EventSource(`/api/games/${id}/events`);
  stream.onmessage = (event) => {
    if (gameId !== id) return;
    const previous = state;
    acceptState(JSON.parse(event.data));
    render();
    if (previous?.status !== state.status)
      void refreshHistory().catch(() => {});
    if (
      state.status === "paused" &&
      previous?.status === "running" &&
      state.logs.at(-1)?.kind === "error"
    )
      toast(state.logs.at(-1).message, true);
  };
  stream.onerror = async () => {
    if (gameId !== id) return;
    try {
      const response = await fetch(`/api/games/${id}`);
      if (response.status === 404) {
        stream?.close();
        gameId = null;
        state = null;
        saveGameId(browserStorage, null);
        render();
        toast("此对局记录已被删除，请从服务器记录选择其他对局。", true);
      } else $("#board-status").textContent = "连接中断，正在自动重连…";
    } catch {
      $("#board-status").textContent = "连接中断，正在自动重连…";
    }
  };
}

async function withBusy(action) {
  if (busy) return;
  busy = true;
  render();
  try {
    await action();
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

async function startMatch(demo) {
  persistSettings();
  const config = settings();
  if (demo) {
    config.demo = true;
    // Demo keeps the selected avatars, prompts and effort without calling a provider.
    config.white = { ...config.white, name: config.white.name || "白方 AI" };
    config.black = { ...config.black, name: config.black.name || "黑方 AI" };
    config.delayMs = 350;
  }
  const data = await api("/api/games", config);
  stream?.close();
  gameId = data.id;
  state = data.state;
  lastMoveCount = -1;
  saveGameId(browserStorage, gameId);
  for (const detail of document.querySelectorAll(".api-settings, .advanced"))
    detail.open = false;
  closePromptEditors();
  render();
  connect();
  await refreshHistory();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  for (const input of form.querySelectorAll("input")) {
    if (!input.checkValidity()) {
      const details = input.closest("details");
      if (details) details.open = true;
    }
  }
  if (!form.reportValidity()) return;
  void withBusy(() => startMatch(false));
});
$("#demo").addEventListener(
  "click",
  () => void withBusy(() => startMatch(true)),
);
$("#copy-config").addEventListener("click", () => {
  for (const key of ["baseUrl", "apiKey", "model"])
    form.elements[`black-${key}`].value = form.elements[`white-${key}`].value;
  renderProfile("black");
  persistSettings();
  toast("已复制白方 API 配置，头像、Prompt 和思考强度仍可独立设置。");
});
for (const button of document.querySelectorAll("[data-reveal]"))
  button.addEventListener("click", () => {
    const input = form.elements[button.dataset.reveal];
    input.type = input.type === "password" ? "text" : "password";
    button.textContent = input.type === "password" ? "显示" : "隐藏";
    button.setAttribute(
      "aria-label",
      `${button.textContent}${button.dataset.reveal.startsWith("white") ? "白方" : "黑方"} API Key`,
    );
  });
$("#flip").addEventListener("click", () => {
  flipped = !flipped;
  drawBoard();
});
$("#copy-fen").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state?.fen || initialFen);
    toast("已复制当前 FEN");
  } catch {
    toast("无法访问剪贴板，请手动复制显示的 FEN。", true);
  }
});
$("#export").addEventListener("click", () => {
  if (gameId) window.location.assign(`/api/games/${gameId}/pgn`);
});
$("#pause").addEventListener(
  "click",
  () =>
    void withBusy(async () => {
      acceptState(
        await api(
          `/api/games/${gameId}/${state.status === "paused" ? "resume" : "pause"}`,
          state.status === "paused" && state.needsConfiguration
            ? settings()
            : undefined,
        ),
      );
    }),
);
$("#save-config").addEventListener(
  "click",
  () =>
    void withBusy(async () => {
      // Disabled timing fields do not affect an existing match.
      const config = settings();
      acceptState(
        await api(`/api/games/${gameId}/configure`, {
          white: config.white,
          black: config.black,
        }),
      );
      closePromptEditors();
      toast("配置已更新，可以继续对局。");
    }),
);
form.elements.timeoutSeconds.addEventListener("input", renderTimeout);
$("#apply-timeout").addEventListener("click", () => {
  if (!form.elements.timeoutSeconds.reportValidity()) return;
  void withBusy(async () => {
    acceptState(
      await api(`/api/games/${gameId}/timeout`, {
        timeoutMs: Number(form.elements.timeoutSeconds.value) * 1000,
      }),
    );
    toast("超时时限已更新，将用于后续走棋和采访请求。");
  });
});
$("#stop").addEventListener("click", () => $("#confirm-dialog").showModal());
$("#confirm-dialog").addEventListener("close", () => {
  if ($("#confirm-dialog").returnValue === "confirm")
    void withBusy(async () => {
      acceptState(await api(`/api/games/${gameId}/stop`));
    });
});
$("#new-game").addEventListener("click", () => {
  $("#white-api-settings").open = true;
  form.elements["white-model"].focus();
});

function renderProfile(side) {
  const value = (key) => form.elements[`${side}-${key}`].value;
  $(`#${side}-name`).textContent =
    value("name").trim() || (side === "white" ? "白方 AI" : "黑方 AI");
  $(`#${side}-model`).textContent = state?.demo
    ? "本地演示 · 无 API 消耗"
    : value("model").trim() || "等待接入模型";
  $(`#${side}-prompt-text`).textContent =
    value("systemPrompt").trim() || "尚未设置策略，AI 将使用默认走棋指令。";
  const avatar = $(`#${side}-avatar`);
  const src = value("avatar");
  if (avatar.dataset.source !== src) {
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = `${side === "white" ? "白方" : "黑方"}头像`;
      avatar.replaceChildren(img);
    } else avatar.textContent = side === "white" ? "♔" : "♚";
    avatar.dataset.source = src;
  }
  $(`[data-reset="${side}"]`).hidden = !src;
  syncEffort(side);
}

function syncEffort(side) {
  const input = form.elements[`${side}-reasoningEffort`];
  const level = Number(input.value);
  const label = effortLabels[level];
  $(`#${side}-effort-value`).textContent = label;
  input.setAttribute(
    "aria-valuetext",
    level === 1
      ? "自动，使用模型默认强度"
      : level === 0
        ? "关闭思考"
        : `${label}思考`,
  );
  input.closest(".effort-control").dataset.level = input.value;
  $(`#${side}-effort-hint`).textContent =
    level === 1
      ? "使用模型默认思考强度"
      : level === 0
        ? "关闭思考，需模型服务支持；DeepSeek 使用原生开关"
        : "需模型服务支持推理强度设置";
}

function hydrateProfiles() {
  form.elements.timeoutSeconds.value = String(state.timeoutMs / 1000);
  // Viewing an older game must not replace the browser's saved AI settings.
  if (savedSettings) return;
  for (const [side, color] of sides) {
    const player = state.players[color];
    for (const key of ["name", "systemPrompt", "avatar"]) {
      if (typeof player[key] === "string")
        form.elements[`${side}-${key}`].value = player[key];
    }
    if (!state.demo) form.elements[`${side}-model`].value = player.model;
    form.elements[`${side}-reasoningEffort`].value = String(
      Math.max(0, efforts.indexOf(player.reasoningEffort)),
    );
  }
}

function togglePrompt(side, open) {
  $(`#${side}-prompt-editor`).hidden = !open;
  $(`#${side}-prompt-text`).hidden = open;
  const button = $(`[data-edit="${side}"]`);
  button.textContent = open ? "收起 ↙" : "编辑 ↗";
  button.setAttribute("aria-expanded", String(open));
  renderProfile(side);
  if (open) form.elements[`${side}-systemPrompt`].focus();
}
function closePromptEditors() {
  for (const [side] of sides) togglePrompt(side, false);
}

async function uploadAvatar(side, file) {
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("请选择 PNG、JPEG 或 WebP 头像图片。");
  if (file.size > 5 * 1024 * 1024) throw new Error("头像图片不能超过 5MB。");
  const image = await createImageBitmap(file);
  try {
    // Crop to a square and compress before passing to the local service.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 160;
    const context = canvas.getContext("2d");
    const size = Math.min(image.width, image.height);
    context.drawImage(
      image,
      (image.width - size) / 2,
      (image.height - size) / 2,
      size,
      size,
      0,
      0,
      160,
      160,
    );
    const data = canvas.toDataURL("image/webp", 0.82);
    if (data.length > 64000)
      throw new Error("图片压缩后仍过大，请选择更小的头像。");
    // A game may have started while the image was decoding.
    if (state?.status === "running" || busy) return;
    form.elements[`${side}-avatar`].value = data;
    renderProfile(side);
    persistSettings();
    toast("头像已设置");
  } finally {
    image.close();
  }
}
for (const [side] of sides) {
  $(`[data-upload="${side}"]`).addEventListener("click", () =>
    $(`#${side}-avatar-file`).click(),
  );
  $(`#${side}-avatar-file`).addEventListener("change", async (event) => {
    try {
      await uploadAvatar(side, event.target.files[0]);
    } catch (error) {
      toast(error.message || "无法读取头像图片", true);
    } finally {
      event.target.value = "";
    }
  });
  $(`[data-reset="${side}"]`).addEventListener("click", () => {
    form.elements[`${side}-avatar`].value = "";
    renderProfile(side);
    persistSettings();
  });
  $(`[data-edit="${side}"]`).addEventListener("click", () =>
    togglePrompt(side, $(`#${side}-prompt-editor`).hidden),
  );
  $(`[data-apply="${side}"]`).addEventListener("click", () =>
    togglePrompt(side, false),
  );
  form.elements[`${side}-reasoningEffort`].addEventListener("input", () =>
    syncEffort(side),
  );
  for (const key of ["name", "model"])
    form.elements[`${side}-${key}`].addEventListener("input", () =>
      renderProfile(side),
    );
}

$("#retry-interviews").addEventListener(
  "click",
  () =>
    void withBusy(async () => {
      acceptState(
        await api(
          `/api/games/${gameId}/interview`,
          state.needsConfiguration ? settings() : undefined,
        ),
      );
    }),
);

form.addEventListener("input", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistSettings, 200);
});
form.addEventListener("change", (event) => {
  if (event.target.name && event.target.type !== "file") persistSettings();
});
window.addEventListener("pagehide", () => {
  if (saveTimer) persistSettings();
});
$("#refresh-history").addEventListener(
  "click",
  () => void withBusy(refreshHistory),
);
$("#open-history").addEventListener("click", () => {
  const id = $("#history-select").value;
  if (id) void withBusy(() => openMatch(id));
});
restoreSettings();
render();
void refreshHistory().catch(() => {
  $("#history-select").options[0].textContent =
    "无法读取对局记录，点击刷新重试";
});
if (gameId) {
  void (async () => {
    try {
      await openMatch(gameId);
    } catch {
      gameId = null;
      saveGameId(browserStorage, null);
      toast("未找到之前的对局，请重新开局。", true);
      render();
    }
  })();
}
