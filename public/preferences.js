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

const settingsKey = "feiyu-player-settings-v1";
const gameKey = "feiyu-game-id";

export function loadPreferences(storage) {
  try {
    const value = JSON.parse(storage.getItem(settingsKey));
    if (value?.version !== 1 || !value.white || !value.black) return null;
    return value;
  } catch {
    return null;
  }
}

export function savePreferences(storage, settings) {
  try {
    storage.setItem(settingsKey, JSON.stringify({ ...settings, version: 1 }));
    return true;
  } catch {
    return false;
  }
}

export function loadGameId(storage) {
  try {
    return storage.getItem(gameKey);
  } catch {
    return null;
  }
}

export function saveGameId(storage, id) {
  try {
    if (id) storage.setItem(gameKey, id);
    else storage.removeItem(gameKey);
  } catch {
    /* A restricted browser can still play without local storage. */
  }
}
