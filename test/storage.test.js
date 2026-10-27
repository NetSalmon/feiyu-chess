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
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Chess } from "chess.js";
import { Match, gameResult } from "../server/game.js";
import { createApp } from "../server/app.js";
import { GameStorage } from "../server/storage.js";
import {
  loadPreferences,
  savePreferences,
  loadGameId,
  saveGameId,
} from "../public/preferences.js";

const id = "12345678-1234-4321-8000-123456789abc";
const config = () => ({
  white: {
    name: "白方",
    model: "deepseek-flash",
    baseUrl: "https://provider.example/Exact//Path/?token=private-query",
    apiKey: "white-private-key",
    systemPrompt: "稳健布局",
    reasoningEffort: "none",
  },
  black: {
    name: "黑方",
    model: "other-model",
    baseUrl: "https://black.example/custom/",
    apiKey: "black-private-key",
    systemPrompt: "伺机反击",
    reasoningEffort: "high",
  },
  delayMs: 0,
  timeoutMs: 1000,
});
const completion = (move) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: "这是我的落子。",
            reasoning_content: "private-but-necessary-model-context",
            tool_calls: [
              {
                id: "move-call",
                type: "function",
                function: {
                  name: "make_move",
                  arguments: JSON.stringify({ move }),
                },
              },
            ],
          },
        },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
function waitFor(match, predicate) {
  if (predicate(match)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      match.off("state", check);
      reject(new Error("等待对局状态超时"));
    }, 4000);
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
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "feiyu-storage-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function serve(t, dataDir, fetchImpl) {
  const runtime = createApp({ dataDir, matchDependencies: { fetchImpl } });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    runtime.dispose();
    const closing = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closing;
  };
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { ...runtime, base, post, close };
}

test("server restart restores a paused match, full tool history and exact URLs supplied by the browser", async (t) => {
  const dir = directory(t);
  const options = config();
  let count = 0;
  const first = await serve(t, dir, async () => {
    if (count++ === 0) return completion("f2f3");
    return new Response("", { status: 503 });
  });
  const created = await first.post("/api/games", options);
  assert.equal(created.status, 201);
  const { id: gameId } = await created.json();
  const original = first.matches.get(gameId);
  await waitFor(original, (m) => m.status === "paused");
  const originalPgn = original.pgn();
  const originalFen = original.chess.fen();
  const oldRevision = original.revision;
  await first.close();
  const raw = readFileSync(join(dir, `${gameId}.json`), "utf8");
  assert.doesNotMatch(
    raw,
    /white-private-key|black-private-key|private-query|provider\.example|black\.example|apiKey|baseUrl/,
  );
  assert.match(raw, /private-but-necessary-model-context/);
  assert.deepEqual(readdirSync(dir), [`${gameId}.json`]);

  const requests = [];
  const remaining = ["e7e5", "g2g4", "d8h4"];
  const second = await serve(t, dir, async (url, { body, headers }) => {
    const data = JSON.parse(body);
    requests.push({ url, data, authorization: headers.Authorization });
    return data.tools
      ? completion(remaining.shift())
      : new Response(
          JSON.stringify({
            choices: [{ message: { content: "赛后感受已记录。" } }],
          }),
        );
  });
  const restored = second.matches.get(gameId);
  assert.equal(restored.status, "paused");
  assert.equal(restored.needsConfiguration, true);
  assert.ok(restored.revision > oldRevision);
  assert.equal(restored.pgn(), originalPgn);
  assert.equal(restored.chess.fen(), originalFen);
  assert.equal(restored.messages.w[0].text, "这是我的落子。");
  assert.equal(restored.players.w.apiKey, "");
  assert.equal(restored.players.w.baseUrl, "");
  assert.equal((await second.post(`/api/games/${gameId}/resume`)).status, 400);
  assert.equal(requests.length, 0);
  const resumed = await second.post(`/api/games/${gameId}/resume`, options);
  assert.equal(resumed.status, 200);
  await waitFor(restored, (m) =>
    Object.values(m.interviews).every((x) => x.status === "completed"),
  );
  assert.equal(restored.result.reason, "将死");
  assert.equal(restored.result.winner, "b");
  assert.deepEqual(
    restored.moves.map((m) => m.uci),
    ["f2f3", "e7e5", "g2g4", "d8h4"],
  );
  const whiteMove = requests.find(
    (r) => r.data.tools && r.data.model === options.white.model,
  );
  assert.equal(whiteMove.url, options.white.baseUrl);
  assert.equal(whiteMove.authorization, "Bearer white-private-key");
  assert.ok(
    whiteMove.data.messages.some(
      (m) => m.role === "tool" && JSON.parse(m.content).ok,
    ),
  );
  assert.ok(
    whiteMove.data.messages.some(
      (m) => m.reasoning_content === "private-but-necessary-model-context",
    ),
  );
  const summaries = await (await fetch(second.base + "/api/games")).json();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].result.score, "0-1");
  assert.doesNotMatch(
    JSON.stringify(summaries),
    /private-key|private-query|reasoning_content|histories/,
  );
  await second.close();

  const third = await serve(t, dir, async () => {
    throw new Error("归档不应自动调用 API");
  });
  const finished = third.matches.get(gameId);
  assert.equal(finished.status, "finished");
  assert.equal(finished.result.winner, "b");
  assert.ok(
    Object.values(finished.interviews).every((x) => x.status === "completed"),
  );
  assert.match(
    await (await fetch(`${third.base}/api/games/${gameId}/pgn`)).text(),
    /Qh4#/,
  );
  const another = await third.post("/api/games", { ...options, demo: true });
  assert.equal(another.status, 201);
  assert.equal(
    (await (await fetch(third.base + "/api/games")).json()).length,
    2,
  );
  assert.equal(
    (await fetch(`${third.base}/api/games/${gameId}`, { method: "DELETE" }))
      .status,
    204,
  );
  assert.ok(!readdirSync(dir).includes(`${gameId}.json`));
  await third.close();
});

test("PGN restore preserves repetition detection, FEN setup and interrupted interviews", (t) => {
  const chess = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"])
    chess.move(move);
  const match = new Match(config(), { chess });
  match.status = "running";
  const restored = Match.fromRecord(
    JSON.parse(JSON.stringify(match.toRecord())),
  );
  assert.equal(restored.status, "paused");
  assert.equal(gameResult(restored.chess).reason, "三次重复局面");
  const special = new Match(config(), {
    chess: new Chess("7k/P7/6K1/8/8/8/8/8 w - - 0 1"),
  });
  const specialRestored = Match.fromRecord(
    JSON.parse(JSON.stringify(special.toRecord())),
  );
  assert.equal(specialRestored.chess.fen(), special.chess.fen());

  const record = match.toRecord();
  record.status = "finished";
  record.result = { winner: null, score: "1/2-1/2", reason: "三次重复局面" };
  record.interviews = {
    w: { status: "completed", text: "已完成采访", error: null },
    b: { status: "running", text: "", error: null },
  };
  const recovered = Match.fromRecord(JSON.parse(JSON.stringify(record)));
  assert.equal(recovered.interviews.w.text, "已完成采访");
  assert.equal(recovered.interviews.b.status, "error");
  assert.match(recovered.interviews.b.error, /服务重启/);
  assert.throws(() => recovered.startInterviews(), /API 配置/);
});

test("atomic storage ignores incomplete temporary files and removes deleted records", (t) => {
  const dir = directory(t);
  const storage = new GameStorage(dir);
  const match = new Match(config());
  storage.save(id, match);
  writeFileSync(join(dir, `${id}.json.tmp`), "unfinished");
  assert.equal(storage.load().length, 1);
  assert.throws(() => storage.save("../unsafe", match), /无效/);
  storage.delete(id);
  assert.deepEqual(storage.load(), []);
});

test("browser settings survive reload with independent API secrets, exact URL and disabled thinking", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const settings = config();
  assert.equal(savePreferences(storage, settings), true);
  const loaded = loadPreferences(storage);
  assert.equal(loaded.white.apiKey, "white-private-key");
  assert.equal(loaded.black.apiKey, "black-private-key");
  assert.equal(loaded.white.baseUrl, settings.white.baseUrl);
  assert.equal(loaded.white.reasoningEffort, "none");
  settings.white.apiKey = "";
  assert.equal(savePreferences(storage, settings), true);
  assert.equal(loadPreferences(storage).white.apiKey, "");
  saveGameId(storage, id);
  assert.equal(loadGameId(storage), id);
  saveGameId(storage, null);
  assert.equal(loadGameId(storage), null);
  values.set("feiyu-player-settings-v1", "{broken");
  assert.equal(loadPreferences(storage), null);
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(loadPreferences(blocked), null);
  assert.equal(savePreferences(blocked, settings), false);
  assert.equal(loadGameId(blocked), null);
  assert.doesNotThrow(() => saveGameId(blocked, id));
});

test("restored interviews accept browser credentials and retry only the interrupted player", async (t) => {
  const dir = directory(t);
  const moves = ["f2f3", "e7e5", "g2g4", "d8h4"];
  let n = 0;
  const original = new Match(config(), {
    fetchImpl: async (_url, { body, signal }) => {
      const request = JSON.parse(body);
      if (request.tools) return completion(moves[n++]);
      if (request.model === "deepseek-flash")
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "白方采访已完成" } }],
          }),
        );
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    },
  });
  original.start();
  await waitFor(
    original,
    (m) =>
      m.interviews.w.status === "completed" &&
      m.interviews.b.status === "running",
  );
  new GameStorage(dir).save(id, original);
  original.stop();
  const requests = [];
  const runtime = await serve(t, dir, async (url, { body }) => {
    requests.push({ url, body: JSON.parse(body) });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "黑方恢复后的采访" } }],
      }),
    );
  });
  const restored = runtime.matches.get(id);
  assert.equal(restored.interviews.b.status, "error");
  assert.equal(
    (await runtime.post(`/api/games/${id}/interview`, config())).status,
    200,
  );
  await waitFor(restored, (m) => m.interviews.b.status === "completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, config().black.baseUrl);
  assert.equal(
    requests[0].body.messages.filter(
      (m) => m.role === "assistant" && m.tool_calls,
    ).length,
    2,
  );
  assert.equal(restored.interviews.w.text, "白方采访已完成");
  assert.equal(restored.interviews.b.text, "黑方恢复后的采访");
  await runtime.close();
});
