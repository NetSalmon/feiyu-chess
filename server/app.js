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

import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Match } from "./game.js";
import { GameStorage } from "./storage.js";

export function createApp({
  matchDependencies,
  cleanupIntervalMs = 60000,
  dataDir = null,
} = {}) {
  const app = express();
  const matches = new Map();
  const storage = dataDir ? new GameStorage(dataDir) : null;
  const track = (id, match) => {
    if (storage) {
      storage.save(id, match);
      match.on("state", (state) => {
        try {
          storage.save(id, match);
          match.persistenceError = null;
        } catch {
          match.persistenceError =
            "服务器保存对局失败，请检查数据目录空间与写入权限。";
          console.error(`对局 ${id} 保存失败`);
        }
        state.persistenceError = match.persistenceError;
      });
    }
    matches.set(id, match);
  };
  for (const record of storage?.load() || []) {
    try {
      track(record.id, Match.fromRecord(record, matchDependencies));
    } catch {
      console.error(`跳过无法恢复的对局存档：${record.id}`);
    }
  }
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    // Keep the local API same-origin; do not enable permissive CORS.
    if (
      req.method !== "GET" &&
      req.headers.origin &&
      req.headers.origin !== `${req.protocol}://${req.headers.host}`
    )
      return res.status(403).json({ error: "只接受同源请求" });
    next();
  });
  app.use(express.json({ limit: "512kb" }));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/games", (_req, res) =>
    res.json(
      [...matches]
        .map(([id, match]) => ({
          id,
          createdAt: match.createdAt,
          updatedAt: match.lastTouched,
          status: match.status,
          demo: match.demo,
          white: match.players.w.name,
          black: match.players.b.name,
          moves: match.moves.length,
          result: match.result,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    ),
  );
  app.post("/api/games", (req, res, next) => {
    try {
      if (
        [...matches.values()].filter((match) =>
          ["ready", "running", "paused"].includes(match.status),
        ).length >= 100
      )
        return res
          .status(429)
          .json({ error: "对局数量已达上限，请先结束旧对局" });
      const match = new Match(req.body, matchDependencies);
      const id = randomUUID();
      track(id, match);
      match.start();
      res.status(201).json({ id, state: match.snapshot() });
    } catch (error) {
      next(error);
    }
  });
  app.use("/api/games/:id", (req, res, next) => {
    const match = matches.get(req.params.id);
    if (!match)
      return res.status(404).json({ error: "对局不存在或已过期，请新建对局" });
    req.match = match;
    next();
  });
  app.get("/api/games/:id", (req, res) => res.json(req.match.snapshot()));
  app.get("/api/games/:id/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (state) => res.write(`data: ${JSON.stringify(state)}\n\n`);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.match.on("state", send);
    send(req.match.snapshot());
    req.on("close", () => {
      clearInterval(heartbeat);
      req.match.off("state", send);
    });
  });
  app.post("/api/games/:id/:action", (req, res, next) => {
    try {
      const match = req.match;
      switch (req.params.action) {
        case "pause":
          match.pause();
          break;
        case "resume":
          if (match.needsConfiguration && req.body?.white && req.body?.black)
            match.updatePlayers(req.body);
          match.start();
          break;
        case "stop":
          match.stop();
          break;
        case "configure":
          match.updatePlayers(req.body);
          break;
        case "timeout":
          match.updateTimeout(req.body?.timeoutMs);
          break;
        case "interview":
          if (match.needsConfiguration && req.body?.white && req.body?.black)
            match.updatePlayers(req.body);
          match.startInterviews();
          break;
        default:
          return res.status(404).json({ error: "未知操作" });
      }
      res.json(match.snapshot());
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/games/:id/pgn", (req, res) => {
    res
      .type("application/x-chess-pgn")
      .attachment("feiyu-chess.pgn")
      .send(req.match.pgn());
  });
  app.delete("/api/games/:id", (req, res) => {
    req.match.stop();
    storage?.delete(req.params.id);
    matches.delete(req.params.id);
    res.sendStatus(204);
  });
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  app.use((error, _req, res, _next) =>
    res.status(400).json({
      error:
        error.type === "entity.too.large"
          ? "配置内容过大"
          : error instanceof SyntaxError
            ? "请求 JSON 格式无效"
            : error.message,
    }),
  );
  const timer = setInterval(() => {
    for (const [id, match] of matches) {
      if (
        !storage &&
        match.status !== "running" &&
        Date.now() - match.lastTouched > 24 * 3600000
      ) {
        match.stop();
        matches.delete(id);
      }
    }
  }, cleanupIntervalMs);
  timer.unref();
  return {
    app,
    matches,
    dispose() {
      clearInterval(timer);
      for (const match of matches.values()) {
        if (match.status === "running") match.pause();
        if (Object.keys(match.interviewControllers).length) match.stop();
      }
    },
  };
}
