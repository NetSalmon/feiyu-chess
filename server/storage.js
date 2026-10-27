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
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

const validId = (id) =>
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id);

export class GameStorage {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  load() {
    const records = [];
    for (const filename of readdirSync(this.directory)) {
      if (!filename.endsWith(".json") || !validId(filename.slice(0, -5)))
        continue;
      try {
        const record = JSON.parse(
          readFileSync(join(this.directory, filename), "utf8"),
        );
        if (record.id !== filename.slice(0, -5))
          throw new Error("存档 ID 不一致");
        records.push(record);
      } catch {
        console.error(`跳过无法读取的对局存档：${filename}`);
      }
    }
    return records;
  }

  save(id, match) {
    if (!validId(id)) throw new Error("无效的对局 ID");
    const target = join(this.directory, `${id}.json`);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify({ id, ...match.toRecord() }), {
      mode: 0o600,
    });
    renameSync(temporary, target);
  }

  delete(id) {
    if (!validId(id)) throw new Error("无效的对局 ID");
    rmSync(join(this.directory, `${id}.json`), { force: true });
  }
}
