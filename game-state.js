/**
 * GameState — сохранение состояния «Клиники» v0.5.
 *
 * Хранит три раздела:
 *   settings - настройки игрока (звук, озвучка, тема, анимации, громкость);
 *   rooms    - какие палаты открыты и сколько раз в них заходили;
 *   progress - игровой прогресс (услышанные реплики, поставленные предметы).
 *
 * Главное правило: игра никогда не ждёт сеть. Любая операция с облаком
 * идёт с таймаутом, при неудаче данные остаются в localStorage, и
 * приложение переключается в локальный режим без ошибок.
 *
 * Использование:
 *
 *   import { GameState } from "./app.js";
 *
 *   const saved = await GameState.init();   // подтянуть из облака
 *   GameState.setSetting("theme", "cold");
 *   GameState.markRoomVisited("3");
 *   GameState.markHeard("kuklotryapka");
 */

import {
  initFirebase,
  isCloud,
  onCloudStatus,
  disableCloud,
  cloudGet,
  cloudSet,
  cloudUpdate,
  cloudOn,
  CLOUD_ROOT
} from "./firebase.js";

const LOCAL_KEY = "clinika.state.v05";

// Идентификатор устройства. Настройки, посещённые комнаты и прогресс -
// личные данные каждого игрока, поэтому в базе они лежат под своим
// идентификатором. Предметы палат, наоборот, общие для всех.
const DEVICE_KEY = "clinika.device.v05";

function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = "dev_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (error) {
    // Если localStorage недоступен - используем временный идентификатор.
    return "dev_temp";
  }
}

// Личные данные игрока лежат под идентификатором устройства.
// Общий раздел для них означал бы, что выключенный кем-то голос
// выключался бы у всех.
const PERSONAL_ROOT = `${CLOUD_ROOT}/players/${deviceId()}`;

const DEFAULTS = {
  settings: {
    sound: true,          // звук двери и атмосферы
    voice: true,          // озвучка персонажей
    theme: "classic",     // classic | cold | warm | mono
    reduceMotion: false,  // меньше анимаций
    masterVolume: 0.7     // общая громкость 0..1
  },
  rooms: {
    current: null,        // последняя палата
    visited: {},          // roomId -> сколько раз заходили
    unlocked: {}          // roomId -> открыта ли палата
  },
  progress: {
    heard: {},            // actorId -> номер последней услышанной реплики
    itemsPlaced: 0,       // сколько предметов поставил игрок
    openedDialogs: {}     // actorId -> открывал ли диалог
  }
};

// ---------------------------------------------------------------------------
// Локальная копия
// ---------------------------------------------------------------------------

let cache = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaults() {
  return clone(DEFAULTS);
}

function readLocal() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = localStorage.getItem(LOCAL_KEY);
  } catch (error) {
    console.warn("[Клиника] localStorage недоступен:", error);
  }
  try {
    cache = raw ? JSON.parse(raw) : {};
  } catch (error) {
    cache = {};
  }
  if (!cache || typeof cache !== "object") cache = {};
  const base = defaults();
  cache.settings = { ...base.settings, ...(cache.settings || {}) };
  cache.rooms = { ...base.rooms, ...(cache.rooms || {}) };
  cache.progress = { ...base.progress, ...(cache.progress || {}) };
  return cache;
}

function writeLocal() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(cache));
    return true;
  } catch (error) {
    console.warn("[Клиника] не удалось сохранить состояние локально:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

/**
 * Записывает раздел состояния: сразу в localStorage, затем в облако.
 * @param {"settings"|"rooms"|"progress"} section
 * @param {object} value
 * @returns {Promise<boolean>} ушло ли в облако
 */
async function push(section, value) {
  const local = readLocal();
  local[section] = value;
  writeLocal();

  if (!isCloud()) return false;
  try {
    await cloudSet(`${PERSONAL_ROOT}/${section}`, value);
    return true;
  } catch (error) {
    console.warn(`[Клиника] раздел ${section} не ушёл в облако:`, error);
    // Запись запретили (правила базы истекли, нет прав, сеть отвалилась).
    // Дальше работаем на localStorage - игра не должна ни зависать,
    // ни терять данные.
    disableCloud(`запись раздела ${section} отклонена`);
    return false;
  }
}

/**
 * Читает раздел: из облака, если оно доступно, иначе из localStorage.
 * @param {string} section
 */
async function pull(section) {
  const local = readLocal();
  if (!isCloud()) return local[section];
  try {
    const value = await cloudGet(`${PERSONAL_ROOT}/${section}`);
    if (value && typeof value === "object") {
      const base = defaults();
      local[section] = { ...base[section], ...value };
      writeLocal();
      return local[section];
    }
  } catch (error) {
    console.warn(`[Клиника] раздел ${section} не прочитан из облака:`, error);
  }
  return local[section];
}

// ---------------------------------------------------------------------------
// Публичный интерфейс
// ---------------------------------------------------------------------------

export const GameState = {
  defaults,

  /**
   * Подключает Firebase и подтягивает сохранённое состояние.
   * @returns {Promise<{cloud: boolean, settings: object, rooms: object, progress: object}>}
   */
  async init() {
    // Облако подключаем, но не блокируем на нём игру.
    await initFirebase();

    const local = readLocal();
    const [settings, rooms, progress] = await Promise.all([
      pull("settings"),
      pull("rooms"),
      pull("progress")
    ]);

    local.settings = { ...DEFAULTS.settings, ...(settings || {}) };
    local.rooms = { ...DEFAULTS.rooms, ...(rooms || {}) };
    local.progress = { ...DEFAULTS.progress, ...(progress || {}) };
    writeLocal();

    return {
      cloud: isCloud(),
      settings: local.settings,
      rooms: local.rooms,
      progress: local.progress
    };
  },

  /** Текущее состояние (копия). */
  get() {
    return clone(readLocal());
  },

  /** Текущие настройки. */
  get settings() {
    return readLocal().settings;
  },

  /** Состояние комнат. */
  get rooms() {
    return readLocal().rooms;
  },

  /** Игровой прогресс. */
  get progress() {
    return readLocal().progress;
  },

  /**
   * Меняет одно поле внутри раздела. Экономнее полной перезаписи:
   * в базу уходит только изменённое поле.
   * @param {"settings"|"rooms"|"progress"} section
   * @param {string} field
   * @param {*} value
   */
  async setField(section, field, value) {
    const local = readLocal();
    local[section] = { ...(local[section] || {}), [field]: value };
    writeLocal();

    if (!isCloud()) return false;
    try {
      await cloudUpdate(`${PERSONAL_ROOT}/${section}`, { [field]: value });
      return true;
    } catch (error) {
      console.warn(`[Клиника] поле ${section}.${field} не ушло в облако:`, error);
      disableCloud(`запись поля ${section}.${field} отклонена`);
      return false;
    }
  },

  /**
   * Меняет одну настройку.
   * @param {"sound"|"voice"|"theme"|"reduceMotion"|"masterVolume"} field
   * @param {*} value
   */
  async setSetting(field, value) {
    const settings = { ...readLocal().settings };
    settings[field] = value;
    // В облако уходит только изменённое поле. Если писать весь раздел
    // целиком, устаревшая копия настроек на этом устройстве затирала бы
    // общие настройки у всех игроков (так однажды голос выключился сразу везде).
    //
    // setField - метод этого же объекта, поэтому вызываем через this.
    await this.setField("settings", field, value);
    return settings;
  },

  /**
   * Отмечает, что игрок зашёл в палату.
   * @param {string} roomId
   */
  async markRoomVisited(roomId) {
    if (!roomId) return;
    const rooms = { ...readLocal().rooms };
    rooms.visited = { ...(rooms.visited || {}) };
    rooms.unlocked = { ...(rooms.unlocked || {}) };
    rooms.visited[roomId] = (rooms.visited[roomId] || 0) + 1;
    rooms.unlocked[roomId] = true;
    rooms.current = roomId;
    await push("rooms", rooms);
  },

  /**
   * Отмечает услышанную реплику персонажа.
   * @param {string} actorId
   */
  async markHeard(actorId) {
    if (!actorId) return;
    const progress = { ...readLocal().progress };
    progress.heard = { ...(progress.heard || {}) };
    progress.heard[actorId] = (progress.heard[actorId] || 0) + 1;
    await push("progress", progress);
  },

  /**
   * Отмечает открытый диалог.
   * @param {string} actorId
   */
  async markDialogOpened(actorId) {
    if (!actorId) return;
    const progress = { ...readLocal().progress };
    progress.openedDialogs = { ...(progress.openedDialogs || {}) };
    progress.openedDialogs[actorId] = true;
    await push("progress", progress);
  },

  /**
   * Считает поставленный предмет.
   */
  async countItemPlaced() {
    const progress = { ...readLocal().progress };
    progress.itemsPlaced = (progress.itemsPlaced || 0) + 1;
    await push("progress", progress);
  },

  /**
   * Подписка на изменения раздела из облака. Если облако выключено -
   * подписка не создаётся, данные остаются локальными.
   * @param {string} section
   * @param {(value: object) => void} callback
   * @returns {Function} отписка
   */
  subscribe(section, callback) {
    if (!isCloud()) return () => {};
    return cloudOn(`${PERSONAL_ROOT}/${section}`, (value) => {
      if (!value || typeof value !== "object") return;
      const local = readLocal();
      const base = defaults();
      local[section] = { ...base[section], ...value };
      writeLocal();
      try { callback(local[section]); } catch (error) {
        console.warn("[Клиника] обработчик подписки ошибся:", error);
      }
    });
  },

  /**
   * Подписка на смену режима "облако / локально".
   *
   * Когда облако возвращается (связь восстановилась или обновились
   * правила базы), приложение должно снова подтянуть настройки из
   * базы - иначе игрок продолжит с локальными значениями.
   */
  onStatus(callback) {
    return onCloudStatus((cloud) => {
      if (cloud) {
        pull("settings").then((settings) => {
          try { callback(true, settings); } catch (error) {
            console.warn("[Клиника] обработчик статуса ошибся:", error);
          }
        });
      } else {
        try { callback(false); } catch (error) {
          console.warn("[Клиника] обработчик статуса ошибся:", error);
        }
      }
    });
  },

  /** Работает ли сейчас облако. */
  get cloud() {
    return isCloud();
  },

  /**
   * Сбрасывает сохранённое состояние игрока.
   *
   * В облаке стирается ТОЛЬКО личный раздел игрока. Общие предметы
   * палат лежат рядом, в корне базы, и сброс одного игрока не должен
   * их затирать. Раньше здесь писалось в корень базы целиком - это
   * стирало предметы всех палат и прогресс остальных игроков.
   */
  async reset() {
    cache = defaults();
    writeLocal();
    if (isCloud()) {
      try {
        await cloudSet(PERSONAL_ROOT, defaults());
      } catch (error) {
        console.warn("[Клиника] не удалось сбросить облако:", error);
      }
    }
    return cache;
  }
};

export default GameState;
