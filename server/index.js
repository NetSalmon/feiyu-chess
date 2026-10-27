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

import { createApp } from "./app.js";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const { app, dispose } = createApp({
  dataDir:
    process.env.FEIYU_DATA_DIR ||
    fileURLToPath(new URL("../data/games", import.meta.url)),
});
const server = app.listen(port, host, (error) => {
  if (!error) console.log(`肥鱼国际象棋已启动：http://${host}:${port}`);
});
server.on("error", (error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    dispose();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
