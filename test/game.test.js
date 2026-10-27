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

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Chess } from "chess.js";
import {
  Match,
  MOVE_TOOL,
  gameResult,
  normalizePlayer,
} from "../server/game.js";
import { createApp } from "../server/app.js";

const player = {
  name: "Test AI",
  model: "test-model",
  baseUrl: "http://127.0.0.1:12345/v1/chat/completions",
  apiKey: "test-secret",
  systemPrompt: "我的自定义棋风",
};
const config = () => ({
  white: { ...player, name: "White", apiKey: "white-secret" },
  black: {
    ...player,
    name: "Black",
    apiKey: "black-secret",
    systemPrompt: "另一套黑方策略",
  },
  delayMs: 0,
  timeoutMs: 1000,
  maxPlies: 400,
});
const completion = (move, name = "make_move") => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name, arguments: JSON.stringify({ move }) },
          },
        ],
      },
    },
  ],
});
const reply = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
function until(match, predicate, timeoutMs = 4000) {
  if (predicate(match)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      match.off("state", check);
      reject(new Error(`Timed out: ${match.status}`));
    }, timeoutMs);
    function check() {
      if (predicate(match)) {
        clearTimeout(timer);
        match.off("state", check);
        resolve();
      }
    }
    match.on("state", check);
  });
}

test("preserves user-provided URLs exactly and validates configuration", () => {
  for (const baseUrl of [
    "https://example.com/v1/chat/completions/",
    "https://example.com/custom/forward/?api-version=2026-10-27&route=a%2Fb",
    "https://example.com/Custom//Endpoint/?z=2&a=1",
    "https://example.com/v1",
  ]) {
    assert.equal(normalizePlayer({ ...player, baseUrl }, "w").baseUrl, baseUrl);
  }
  assert.throws(
    () => normalizePlayer({ ...player, baseUrl: "file:///etc/passwd" }, "w"),
    /HTTP/,
  );
  assert.throws(
    () => normalizePlayer({ ...player, model: "" }, "w"),
    /模型名称/,
  );
  assert.throws(() => new Match({ ...config(), timeoutMs: -1 }), /请求超时/);
});

test("automatically alternates independent APIs, passes custom prompts and detects checkmate", async (t) => {
  const sequence = ["f2f3", "e7e5", "g2g4", "d8h4"];
  const requests = [];
  const interviews = [];
  const interviewUrls = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (!body.tools) {
      interviews.push(body);
      interviewUrls.push(req.url);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "这盘棋让我更重视王的安全。",
              },
            },
          ],
        }),
      );
      return;
    }
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body,
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(completion(sequence[requests.length - 1])));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => {
    provider.close();
    provider.closeAllConnections();
  });
  const endpoint = `http://127.0.0.1:${provider.address().port}`;
  const options = config();
  const whitePath = "/white/custom/forward/?api-version=2026-10-27&route=a%2Fb";
  const blackPath = "/black/v1/chat/completions/";
  options.white.baseUrl = endpoint + whitePath;
  options.black.baseUrl = endpoint + blackPath;
  const match = new Match(options);
  t.after(() => match.stop());
  match.start();
  await until(match, (m) => m.status === "finished");
  await until(match, (m) =>
    Object.values(m.interviews).every((i) => i.status === "completed"),
  );
  assert.equal(match.result.winner, "b");
  assert.equal(match.result.reason, "将死");
  assert.equal(interviews.length, 2);
  assert.deepEqual(interviewUrls.slice().sort(), [whitePath, blackPath].sort());
  for (const interview of interviews) {
    assert.equal(interview.tools, undefined);
    assert.equal(
      interview.messages.filter((m) => m.role === "assistant" && m.tool_calls)
        .length,
      2,
    );
    assert.equal(
      interview.messages.filter(
        (m) => m.role === "tool" && JSON.parse(m.content).ok,
      ).length,
      2,
    );
    const question = JSON.parse(interview.messages.at(-1).content);
    assert.equal(question.phase, "post_match_interview");
    assert.equal(
      question.your_result,
      question.your_color === "w" ? "loss" : "win",
    );
    assert.match(question.pgn, /Qh4#/);
    assert.equal(question.questions.length, 3);
  }
  assert.equal(
    requests[2].body.messages.filter((m) => m.role === "assistant").length,
    1,
  );
  assert.equal(requests[0].body.reasoning_effort, undefined);
  assert.deepEqual(
    match.moves.map((m) => m.uci),
    sequence,
  );
  assert.deepEqual(
    requests.map((r) => r.url),
    [whitePath, blackPath, whitePath, blackPath],
  );
  assert.deepEqual(
    requests.map((r) => r.authorization),
    [
      "Bearer white-secret",
      "Bearer black-secret",
      "Bearer white-secret",
      "Bearer black-secret",
    ],
  );
  assert.match(requests[0].body.messages[0].content, /我的自定义棋风/);
  assert.match(requests[1].body.messages[0].content, /另一套黑方策略/);
  assert.deepEqual(requests[0].body.tools, [MOVE_TOOL]);
  assert.equal(requests[0].body.tool_choice, "auto");
  assert.ok(
    JSON.parse(requests[1].body.messages[1].content).legal_moves.includes(
      "e7e5",
    ),
  );
  assert.match(match.pgn(), /0-1/);
  assert.doesNotMatch(
    JSON.stringify(match.snapshot()),
    /secret|apiKey|baseUrl/,
  );
});

test("rejects illegal move and supplies tool feedback before accepting correction", async (t) => {
  let calls = 0;
  let retry;
  const match = new Match(config(), {
    fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) return reply(completion("e2e5"));
      if (calls === 2) {
        retry = JSON.parse(options.body);
        return reply(completion("e2e4"));
      }
      return new Response("", { status: 503 });
    },
  });
  t.after(() => match.stop());
  match.start();
  await until(match, (m) => m.status === "paused");
  assert.equal(match.moves.length, 1);
  assert.equal(match.moves[0].san, "e4");
  assert.ok(
    retry.messages.some(
      (m) =>
        m.role === "tool" &&
        m.tool_call_id === "call_1" &&
        m.content.includes("Illegal move"),
    ),
  );
  assert.equal(retry.messages.at(-1).role, "user");
});

test("missing tools, malformed JSON, and multiple moves cannot alter the board; three failures forfeit", async (t) => {
  for (const message of [
    { choices: [{ message: { content: "e4" } }] },
    {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "a",
                function: { name: "make_move", arguments: "{broken" },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          message: {
            tool_calls: [
              completion("e2e4").choices[0].message.tool_calls[0],
              {
                id: "b",
                function: { name: "make_move", arguments: '{"move":"d2d4"}' },
              },
            ],
          },
        },
      ],
    },
  ]) {
    let calls = 0;
    const match = new Match(config(), {
      fetchImpl: async (_url, options) => {
        if (!JSON.parse(options.body).tools)
          return reply({
            choices: [{ message: { content: "接受结果，继续提升。" } }],
          });
        calls++;
        return reply(message);
      },
    });
    match.start();
    await until(match, (m) => m.status === "finished");
    assert.equal(calls, 3);
    assert.equal(match.moves.length, 0);
    assert.equal(match.result.winner, "b");
    assert.match(match.result.reason, /连续 3 次/);
    match.stop();
  }
});

test("API error pauses without awarding a winner and supports reconfiguration and resume", async (t) => {
  let failed = true;
  const match = new Match(config(), {
    fetchImpl: async () =>
      failed
        ? new Response("white-secret", { status: 401 })
        : reply(completion("e2e4")),
  });
  t.after(() => match.stop());
  match.start();
  await until(match, (m) => m.status === "paused");
  assert.equal(match.result, null);
  assert.equal(match.moves.length, 0);
  assert.doesNotMatch(JSON.stringify(match.snapshot()), /white-secret/);
  match.updatePlayers({ white: { ...player, name: "Updated" }, black: player });
  assert.equal(match.players.w.name, "Updated");
  failed = false;
  match.start();
  await until(match, (m) => m.moves.length === 1);
  match.pause();
  assert.equal(match.moves[0].san, "e4");
});

test("pause/resume ignores a late response from the previously aborted request", async (t) => {
  const resolvers = [];
  const match = new Match(config(), {
    fetchImpl: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  t.after(() => match.stop());
  match.start();
  assert.equal(resolvers.length, 1);
  match.pause();
  match.start();
  assert.equal(resolvers.length, 2);
  const stale = completion("e2e4");
  stale.choices[0].message.content = "迟到的发言";
  resolvers[0](reply(stale));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(match.moves.length, 0);
  assert.equal(match.histories.w.length, 0);
  assert.deepEqual(match.messages.w, []);
  resolvers[1](reply(completion("d2d4")));
  await until(match, (m) => m.moves.length === 1);
  match.pause();
  assert.equal(match.moves[0].uci, "d2d4");
  assert.doesNotMatch(
    JSON.stringify(match.histories.w.filter((m) => m.role === "assistant")),
    /e2e4/,
  );
});

test("request timeout pauses and aborts provider request", async () => {
  const match = new Match(config(), {
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Aborted")), {
          once: true,
        }),
      ),
  });
  match.start();
  match.updateTimeout(2000);
  await until(match, (m) => m.status === "paused");
  assert.equal(match.moves.length, 0);
  assert.equal(match.timeoutMs, 2000);
  assert.match(match.logs.at(-1).message, /超时（1 秒）/);
});

test("automatic rule results include stalemate, insufficient material, repetition, and fifty-move draw", () => {
  assert.equal(
    gameResult(new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).reason,
    "逼和",
  );
  assert.equal(
    gameResult(new Chess("7k/8/6K1/8/8/8/8/8 w - - 0 1")).reason,
    "子力不足",
  );
  assert.equal(
    gameResult(new Chess("7k/8/6K1/8/8/8/R7/8 w - - 100 60")).reason,
    "五十回合规则",
  );
  const chess = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"])
    chess.move(move);
  assert.equal(gameResult(chess).reason, "三次重复局面");
});

test("special UCI moves handle promotion, castling, and en passant", async (t) => {
  const fixtures = [
    ["7k/P7/6K1/8/8/8/8/8 w - - 0 1", "a7a8q", "Q"],
    ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1", "O-O"],
    ["7k/8/8/3pP3/8/8/8/K7 w - d6 0 2", "e5d6", "exd6"],
  ];
  for (const [fen, move, expected] of fixtures) {
    let first = true;
    const match = new Match(config(), {
      chess: new Chess(fen),
      fetchImpl: async () => {
        if (first) {
          first = false;
          return reply(completion(move));
        }
        return new Response("", { status: 503 });
      },
    });
    t.after(() => match.stop());
    match.start();
    await until(match, (m) => m.moves.length === 1);
    if (match.status === "running") match.pause();
    assert.ok(match.moves[0].san.includes(expected));
    assert.equal(match.moves[0].uci, move);
  }
});

test("configured half-move limit ends game as an explicit adjudicated draw", async () => {
  const sequence = ["e2e4", "e7e5", "g1f3", "b8c6"];
  let n = 0;
  const match = new Match(
    { ...config(), maxPlies: 4 },
    { fetchImpl: async () => reply(completion(sequence[n++])) },
  );
  match.start();
  await until(match, (m) => m.status === "finished");
  assert.equal(match.moves.length, 4);
  assert.equal(match.result.winner, null);
  assert.match(match.result.reason, /半回合上限/);
});

test("HTTP routes expose state and SSE, support pause and PGN, and reject cross-origin mutations", async (t) => {
  const runtime = createApp({
    matchDependencies: {
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("Aborted")), {
            once: true,
          }),
        ),
    },
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    runtime.dispose();
    server.close();
    server.closeAllConnections();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, headers = {}) =>
    fetch(base + url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal(
    (await post("/api/games", config(), { Origin: "https://other.example" }))
      .status,
    403,
  );
  assert.equal(
    (await post("/api/games", { ...config(), white: {} })).status,
    400,
  );
  const response = await post("/api/games", config());
  assert.equal(response.status, 201);
  const { id, state } = await response.json();
  assert.equal(state.status, "running");
  assert.equal(state.timeoutMs, 1000);
  const updatedTimeout = await post(`/api/games/${id}/timeout`, {
    timeoutMs: 300000,
  });
  assert.equal(updatedTimeout.status, 200);
  assert.equal((await updatedTimeout.json()).timeoutMs, 300000);
  assert.equal(
    (await post(`/api/games/${id}/timeout`, { timeoutMs: 0 })).status,
    400,
  );
  assert.equal(
    (await (await fetch(`${base}/api/games/${id}`)).json()).timeoutMs,
    300000,
  );
  assert.doesNotMatch(JSON.stringify(state), /secret/);
  const controller = new AbortController();
  const events = await fetch(`${base}/api/games/${id}/events`, {
    signal: controller.signal,
  });
  assert.equal(
    events.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  const reader = events.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /data:.*running/);
  controller.abort();
  await reader.cancel().catch(() => {});
  const paused = await post(`/api/games/${id}/pause`);
  assert.equal((await paused.json()).status, "paused");
  const pgn = await fetch(`${base}/api/games/${id}/pgn`);
  assert.match(await pgn.text(), /\[White "White"\]/);
  assert.match(pgn.headers.get("content-disposition"), /feiyu-chess.pgn/);
  assert.equal(
    (await fetch(`${base}/api/games/${id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal((await fetch(`${base}/api/games/${id}`)).status, 404);
});

test("validates reasoning strength and avatars without reflecting API secrets", () => {
  const avatar =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC3sAAAAASUVORK5CYII=";
  const normalized = normalizePlayer(
    { ...player, reasoningEffort: "high", avatar },
    "w",
  );
  assert.equal(normalized.reasoningEffort, "high");
  assert.equal(normalized.avatar, avatar);
  for (const reasoningEffort of ["maximum", 3, {}, false])
    assert.throws(
      () => normalizePlayer({ ...player, reasoningEffort }, "w"),
      /思考强度/,
    );
  for (const avatar of [
    "https://example.com/avatar.png",
    "data:image/svg+xml;base64,AAAA",
    "data:image/png;base64," + "A".repeat(64000),
  ])
    assert.throws(() => normalizePlayer({ ...player, avatar }, "w"), /头像/);
  const match = new Match({ ...config(), white: { ...player, avatar } });
  assert.equal(match.snapshot().players.w.avatar, avatar);
  assert.equal(match.snapshot().players.w.systemPrompt, player.systemPrompt);
  assert.doesNotMatch(
    JSON.stringify(match.snapshot()),
    /test-secret|apiKey|baseUrl|histories/,
  );
});

test("sends independent reasoning effort and keeps it in the interview requests", async (t) => {
  const requests = [];
  const sequence = ["f2f3", "e7e5", "g2g4", "d8h4"];
  let move = 0;
  const options = config();
  options.white.reasoningEffort = "high";
  options.black.reasoningEffort = "low";
  const match = new Match(options, {
    fetchImpl: async (_url, { body }) => {
      const data = JSON.parse(body);
      requests.push(data);
      return data.tools
        ? reply(completion(sequence[move++]))
        : reply({
            choices: [{ message: { content: "保持冷静，认真复盘。" } }],
          });
    },
  });
  t.after(() => match.stop());
  match.start();
  await until(match, (m) =>
    Object.values(m.interviews).every((i) => i.status === "completed"),
  );
  assert.deepEqual(
    requests.filter((r) => r.tools).map((r) => r.reasoning_effort),
    ["high", "low", "high", "low"],
  );
  assert.deepEqual(
    requests
      .filter((r) => !r.tools)
      .map((r) => r.reasoning_effort)
      .sort(),
    ["high", "low"],
  );
});

test("interview failure preserves the result, retries only failed players, and does not duplicate successful interviews", async (t) => {
  const sequence = ["f2f3", "e7e5", "g2g4", "d8h4"];
  const counts = { w: 0, b: 0 };
  let move = 0;
  const match = new Match(config(), {
    fetchImpl: async (_url, { body }) => {
      const data = JSON.parse(body);
      if (data.tools) return reply(completion(sequence[move++]));
      const color = JSON.parse(data.messages.at(-1).content).your_color;
      counts[color]++;
      if (color === "w" && counts.w === 1)
        return new Response("white-secret", { status: 503 });
      return reply({
        choices: [{ message: { content: `${color} 赛后感言` } }],
      });
    },
  });
  t.after(() => match.stop());
  match.start();
  await until(
    match,
    (m) =>
      m.interviews.w.status === "error" &&
      m.interviews.b.status === "completed",
  );
  assert.equal(match.status, "finished");
  assert.equal(match.result.winner, "b");
  assert.doesNotMatch(JSON.stringify(match.snapshot()), /white-secret/);
  match.startInterviews();
  match.startInterviews();
  await until(match, (m) => m.interviews.w.status === "completed");
  assert.deepEqual(counts, { w: 2, b: 1 });
  assert.equal(match.moves.length, 4);
  assert.equal(match.interviews.b.text, "b 赛后感言");
});

test("deleting a match aborts interviews and discards late interview responses", async () => {
  const pending = [];
  const match = new Match(config(), {
    fetchImpl: () => new Promise((resolve) => pending.push(resolve)),
  });
  match.finish({ winner: null, score: "1/2-1/2", reason: "和棋" });
  assert.equal(pending.length, 2);
  match.stop();
  for (const resolve of pending)
    resolve(reply({ choices: [{ message: { content: "迟到的采访" } }] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(match.interviews.w.status, "error");
  assert.equal(match.interviews.b.status, "error");
  assert.equal(match.interviews.w.text, "");
});

test("DeepSeek thinking uses automatic tool choice and preserves reasoning on tool and text-only turns", async (t) => {
  const options = config();
  options.white.model = options.black.model = "deepseek-flash";
  options.white.reasoningEffort = options.black.reasoningEffort = "high";
  const sequence = ["f2f3", "e7e5", "g2g4", "d8h4"];
  const requests = [];
  let moves = 0;
  let first = true;
  const match = new Match(options, {
    fetchImpl: async (_url, { body }) => {
      const data = JSON.parse(body);
      requests.push(data);
      assert.deepEqual(data.thinking, { type: "enabled" });
      assert.equal(data.reasoning_effort, "high");
      for (const message of data.messages.filter(
        (m) => m.role === "assistant",
      )) {
        assert.equal(typeof message.reasoning_content, "string");
      }
      if (!data.tools)
        return reply({ choices: [{ message: { content: "复盘完成。" } }] });
      assert.equal(data.tool_choice, "auto");
      if (first) {
        first = false;
        return reply({
          choices: [
            {
              message: {
                role: "assistant",
                content: "准备落子",
                reasoning_content: "text-only-turn-context",
              },
            },
          ],
        });
      }
      const dataOut = completion(sequence[moves++]);
      dataOut.choices[0].message.reasoning_content = `tool-turn-context-${moves}`;
      return reply(dataOut);
    },
  });
  t.after(() => match.stop());
  match.start();
  await until(match, (m) =>
    Object.values(m.interviews).every((i) => i.status === "completed"),
  );
  assert.equal(match.moves.length, 4);
  assert.equal(requests.length, 7);
  assert.equal(
    requests[1].messages.find((m) => m.role === "assistant").reasoning_content,
    "text-only-turn-context",
  );
  const whiteInterview = requests.find(
    (r) => !r.tools && JSON.parse(r.messages.at(-1).content).your_color === "w",
  );
  assert.equal(
    whiteInterview.messages.filter((m) => m.role === "assistant").length,
    3,
  );
});

test("structured API errors explain 400 failures while redacting keys and private URLs", async (t) => {
  const options = config();
  const url = "https://example.com/custom?token=query-secret";
  options.white.baseUrl = url;
  const match = new Match(options, {
    fetchImpl: async () =>
      replyWithStatus(
        {
          error: {
            message: `Thinking mode does not support this tool_choice; white-secret; black-secret; Bearer private-value; ${url}; https://other.example/?api_key=private-query`,
          },
        },
        400,
      ),
  });
  t.after(() => match.stop());
  match.start();
  await until(match, (m) => m.status === "paused");
  assert.match(
    match.logs.at(-1).message,
    /HTTP 400.*Thinking mode does not support this tool_choice/,
  );
  assert.doesNotMatch(
    JSON.stringify(match.snapshot()),
    /white-secret|black-secret|query-secret|private-value|private-query/,
  );
  assert.equal(match.moves.length, 0);
  assert.equal(match.result, null);
});

function replyWithStatus(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("timeout limits support long reasoning and updates while paused or finished", () => {
  for (const timeoutMs of [1000, 300000, 3600000]) {
    const match = new Match({ ...config(), timeoutMs });
    assert.equal(match.snapshot().timeoutMs, timeoutMs);
    match.status = "paused";
    match.updateTimeout(600000);
    assert.equal(match.timeoutMs, 600000);
    match.status = "finished";
    match.updateTimeout(1200000);
    assert.equal(match.snapshot().timeoutMs, 1200000);
    for (const invalid of [0, 999, 3600001, 1000.5, "60000", null]) {
      assert.throws(() => match.updateTimeout(invalid), /请求超时/);
      assert.equal(match.timeoutMs, 1200000);
    }
  }
});

test("public messages contain normal output from retries and tool calls without exposing reasoning", async (t) => {
  const responses = [
    {
      choices: [
        { message: { content: "  ", reasoning_content: "private-thought-1" } },
      ],
    },
    {
      choices: [
        {
          message: {
            content: "先观察中心。\n<script>普通文本</script>",
            reasoning_content: "private-thought-2",
          },
        },
      ],
    },
    completion("e2e4"),
  ];
  responses[2].choices[0].message.content = "我走 e4。";
  responses[2].choices[0].message.reasoning_content = "private-thought-3";
  let n = 0;
  const match = new Match(config(), {
    fetchImpl: async () =>
      n < responses.length
        ? reply(responses[n++])
        : new Response("", { status: 503 }),
  });
  t.after(() => match.stop());
  match.start();
  await until(match, (m) => m.status === "paused");
  assert.equal(match.moves.length, 1);
  const { messages } = match.snapshot();
  assert.deepEqual(
    messages.w.map((m) => m.text),
    ["先观察中心。\n<script>普通文本</script>", "我走 e4。"],
  );
  assert.deepEqual(
    messages.w.map((m) => m.ply),
    [1, 1],
  );
  assert.ok(messages.w[1].id > messages.w[0].id);
  assert.ok(
    messages.w.every(
      (m) => m.phase === "move" && !Number.isNaN(Date.parse(m.time)),
    ),
  );
  assert.deepEqual(messages.b, []);
  assert.doesNotMatch(
    JSON.stringify(match.snapshot()),
    /private-thought|reasoning_content|white-secret/,
  );
  assert.match(JSON.stringify(match.histories.w), /private-thought-2/);
});

test("thinking can be disabled independently for DeepSeek and other providers, including interviews", async (t) => {
  const options = config();
  options.white.model = "deepseek-flash";
  options.white.reasoningEffort = options.black.reasoningEffort = "none";
  const sequence = ["f2f3", "e7e5", "g2g4", "d8h4"];
  let move = 0;
  const requests = [];
  const match = new Match(options, {
    fetchImpl: async (_url, { body }) => {
      const request = JSON.parse(body);
      requests.push(request);
      if (request.tools) return reply(completion(sequence[move++]));
      return reply({
        choices: [
          {
            message: {
              content: `${request.model} 的赛后感受。`,
              reasoning_content: "hidden-interview-thought",
            },
          },
        ],
      });
    },
  });
  t.after(() => match.stop());
  match.start();
  await until(match, (m) =>
    Object.values(m.interviews).every((i) => i.status === "completed"),
  );
  assert.equal(requests.length, 6);
  for (const request of requests) {
    if (request.model === "deepseek-flash") {
      assert.deepEqual(request.thinking, { type: "disabled" });
      assert.equal(request.reasoning_effort, undefined);
    } else {
      assert.equal(request.thinking, undefined);
      assert.equal(request.reasoning_effort, "none");
    }
  }
  for (const color of ["w", "b"]) {
    assert.equal(match.messages[color].length, 1);
    assert.equal(match.messages[color][0].phase, "interview");
    assert.equal(match.messages[color][0].text, match.interviews[color].text);
    assert.equal(match.snapshot().players[color].reasoningEffort, "none");
  }
  assert.doesNotMatch(
    JSON.stringify(match.snapshot()),
    /hidden-interview-thought/,
  );
});
