/**
 * Firebase для «Клиники» v0.5 — статический фронтенд.
 *
 * Модуль подключается к облаку прямо из браузера: никакого своего
 * бэкенда не нужно. Работает на GitHub Pages как есть.
 *
 * Главная задача модуля - никогда не дать игре зависнуть. В проекте
 * Realtime Database может быть ещё не создана, и тогда Firebase SDK
 * не бросает ошибку, а молча не отвечает. Поэтому:
 *
 *   1. перед подключением база проверяется быстрым REST-запросом;
 *   2. если базы нет (404) - облако выключается, игра работает через
 *      localStorage;
 *   3. каждая операция с базой идёт с таймаутом;
 *   4. если правила базы запрещают доступ (PERMISSION_DENIED) -
 *      облако выключается само, игра продолжает работать локально.
 *
 * Использование:
 *
 *   import { initFirebase, isCloud, cloudGet, cloudSet, cloudOn }
 *     from "./firebase.js";
 *
 *   await initFirebase();          // false - если базы нет
 *   if (isCloud()) {
 *     await cloudSet("clinica/settings", { theme: "cold" });
 *   }
 */

// ---------------------------------------------------------------------------
// Конфигурация приложения CLINIC
// ---------------------------------------------------------------------------

export const firebaseConfig = {
  apiKey: "AIzaSyD064Ul_rnCQ41nuZQCBqJ82N8YWa7xoXE",
  authDomain: "clinika-1a6cb.firebaseapp.com",
  projectId: "clinika-1a6cb",
  storageBucket: "clinika-1a6cb.firebasestorage.app",
  messagingSenderId: "347160481113",
  appId: "1:347160481113:web:2445979974554660035048",
  measurementId: "G-ENDSL1NM0Z"
};

export const APP_NAME = "CLINIC";
export const APP_VERSION = "0.5";

// Версия SDK. Один модуль на всё приложение.
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";

// Сколько ждём ответа базы, прежде чем считать её недоступной.
const TIMEOUT_MS = 6000;

// Сколько ждём соединения с базой. Пока база поднимается - игрок
// ждёт, поэтому верхнюю границу держим маленькой.
const CONNECT_TIMEOUT_MS = 4000;

// Адрес базы. SDK сам выбирает хост по умолчанию, но явный адрес
// надёжнее - он не зависит от того, как Firebase ищет регион.
export const DATABASE_URL =
  `https://${firebaseConfig.projectId}-default-rtdb.firebaseio.com`;

// ---------------------------------------------------------------------------
// Внутреннее состояние
// ---------------------------------------------------------------------------

let sdk = null;          // { app, db, ...модули SDK }
let cloud = false;       // работаем ли с облаком прямо сейчас
const statusListeners = new Set();

function setCloud(value, reason) {
  if (cloud === value) return;
  cloud = value;
  if (!value && reason) {
    console.info(`[Клиника] облако отключено: ${reason}`);
  }
  statusListeners.forEach((fn) => {
    try { fn(value); } catch (error) { /* слушатель не должен ломать игру */ }
  });
}

/**
 * Выключает облако и переводит игру на localStorage.
 *
 * Нужно, когда база есть, но работать с ней нельзя: правила запрещают
 * запись (срок правил истёк), сеть отвалилась, доступ заблокирован.
 * Игра при этом продолжает работать - просто без синхронизации.
 *
 * @param {string} reason причина, для журнала
 */
export function disableCloud(reason) {
  setCloud(false, reason || "облако недоступно");
}

/**
 * Подписка на смену режима (облако / локально).
 * @param {(cloud: boolean) => void} fn
 * @returns {Function} отписка
 */
export function onCloudStatus(fn) {
  statusListeners.add(fn);
  fn(cloud);
  return () => statusListeners.delete(fn);
}

/** Работает ли сейчас облако. */
export function isCloud() {
  return cloud;
}

// ---------------------------------------------------------------------------
// Загрузка SDK и проверка базы
// ---------------------------------------------------------------------------

async function loadSdk() {
  if (sdk) return sdk;
  const appModule = await import(`${SDK}firebase-app.js`);
  const dbModule = await import(`${SDK}firebase-database.js`);
  const app = appModule.initializeApp(firebaseConfig);
  // Явный адрес базы: SDK не должен угадывать регион.
  const db = dbModule.getDatabase(app, DATABASE_URL);
  sdk = { app, db, ...dbModule };
  return sdk;
}

/**
 * Проверяет, что база действительно на связи.
 *
 * Важный нюанс: REST-запрос к .json идёт по HTTP, а SDK работает через
 * WebSocket. Если HTTP отвечает, а WebSocket - нет, SDK всё равно
 * будет висеть. Поэтому проверяем именно соединение SDK:
 * .info/connected становится true только при живом подключении.
 */
async function probeDatabase(sdk) {
  // 1. Соединение с базой.
  const connected = await new Promise((resolve) => {
    let done = false;
    let connection = null;

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (connection) {
        try { connection(); } catch (error) { /* уже отписались */ }
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);

    try {
      connection = sdk.onValue(
        sdk.ref(sdk.db, ".info/connected"),
        (snapshot) => {
          // Первый вызов приходит с false - соединение ещё не готово.
          // Ждём именно true, иначе проба всегда даёт ложный отказ.
          if (snapshot.val() === true) finish(true);
        },
        (error) => {
          console.warn("[Клиника] подписка на базу отклонена:", error);
          finish(false);
        }
      );
    } catch (error) {
      finish(false);
    }
  });

  if (!connected) return false;

  // 2. Права на чтение. Соединение может быть живым, а доступ -
  //    запрещён (например, срок правил базы истёк). Тогда облако
  //    бесполезно, и игра должна уйти в локальный режим сразу,
  //    а не после первой неудачной записи.
  //
  //    Путь не содержит точек - в Firebase ключ с точкой недопустим.
  try {
    await withTimeout(
      sdk.get(sdk.ref(sdk.db, CLOUD_ROOT)),
      3500,
      "Проверка прав на чтение"
    );
  } catch (error) {
    console.warn("[Клиника] нет прав на чтение из базы:", error);
    return false;
  }

  // 3. Права на запись. Без них прогресс не сохранится, значит облако
  //    не выполняет свою задачу. Проверяем служебной записью, которую
  //    сразу удаляем.
  const probeRef = sdk.ref(sdk.db, `${CLOUD_ROOT}/_probe`);
  try {
    await withTimeout(
      sdk.set(probeRef, { t: Date.now() }).then(() => sdk.remove(probeRef)),
      3500,
      "Проверка прав на запись"
    );
  } catch (error) {
    console.warn("[Клиника] нет прав на запись в базу:", error);
    return false;
  }

  return true;
}

// Таймер автопереподключения.
let reconnectTimer = null;

/**
 * Периодически проверяет базу. Если связь восстановилась (или
 * обновились правила) - возвращает игру в облачный режим.
 * Проверка лёгкая: только соединение, без записи.
 */
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    if (cloud) return;
    if (!sdk) return;
    const connected = await new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 5000);
      try {
        const connection = sdk.onValue(
          sdk.ref(sdk.db, ".info/connected"),
          (snapshot) => { if (snapshot.val() === true) finish(true); },
          () => finish(false)
        );
        setTimeout(() => { try { connection(); } catch (error) { /* отписались */ } }, 500);
      } catch (error) {
        finish(false);
      }
    });
    if (connected) {
      console.info("[Клиника] связь с базой восстановлена.");
      setCloud(true);
    }
  }, 30000);
}

/**
 * Подключает Firebase. Возвращает true, если облако доступно.
 * @returns {Promise<boolean>}
 */
export async function initFirebase() {
  let loaded;
  try {
    loaded = await loadSdk();
  } catch (error) {
    console.warn("[Клиника] Firebase SDK не загрузился:", error);
    setCloud(false, "SDK недоступен");
    return false;
  }

  // Проверяем живую связь с базой. Если базы нет или она не на связи -
  // облако выключается, игра продолжает работать через localStorage.
  const connected = await probeDatabase(loaded);
  if (!connected) {
    console.warn("[Клиника] база Firebase не на связи - локальный режим.");
    setCloud(false, "Realtime Database не на связи");
    scheduleReconnect();
    return false;
  }

  console.info("[Клиника] Firebase на связи.");
  setCloud(true);
  scheduleReconnect();
  return true;
}

// ---------------------------------------------------------------------------
// Таймаут
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${label || "Firebase"}: нет ответа за ${ms / 1000} с`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Операции с базой
// ---------------------------------------------------------------------------

function requireSdk() {
  if (!sdk) throw new Error("Firebase не инициализирован");
  return sdk;
}

/**
 * Читает данные по пути. Возвращает null, если облако выключено.
 * @param {string} path путь относительно корня базы, например "clinica/settings"
 */
export async function cloudGet(path) {
  if (!cloud) return null;
  const { get, ref, db } = requireSdk();
  const snapshot = await withTimeout(get(ref(db, path)), TIMEOUT_MS, "Чтение");
  return snapshot.val();
}

/**
 * Записывает данные по пути.
 * @param {string} path путь
 * @param {*} value значение
 */
export async function cloudSet(path, value) {
  if (!cloud) return false;
  const { set, ref, db } = requireSdk();
  await withTimeout(set(ref(db, path), value), TIMEOUT_MS, "Запись");
  return true;
}

/**
 * Обновляет отдельные поля по пути.
 * @param {string} path путь
 * @param {Object} value объект с полями
 */
export async function cloudUpdate(path, value) {
  if (!cloud) return false;
  const { update, ref, db } = requireSdk();
  await withTimeout(update(ref(db, path), value), TIMEOUT_MS, "Обновление");
  return true;
}

/**
 * Удаляет данные по пути.
 * @param {string} path путь
 */
export async function cloudRemove(path) {
  if (!cloud) return false;
  const { remove, ref, db } = requireSdk();
  await withTimeout(remove(ref(db, path)), TIMEOUT_MS, "Удаление");
  return true;
}

/**
 * Подписка на изменения по пути - приходит сразу при подписке и
 * потом при каждом изменении из любого браузера.
 *
 * @param {string} path путь
 * @param {(value: any) => void} onValueCallback
 * @returns {Function} отписка
 */
export function cloudOn(path, onValueCallback) {
  if (!cloud) return () => {};
  const { onValue, ref, db } = requireSdk();
  try {
    const unsubscribe = onValue(
      ref(db, path),
      (snapshot) => {
        try { onValueCallback(snapshot.val()); } catch (error) {
          console.warn("[Клиника] обработчик подписки ошибся:", error);
        }
      },
      (error) => {
        // PERMISSION_DENIED или база исчезла - облако больше не нужно.
        console.warn("[Клиника] подписка не работает:", error);
        setCloud(false, "правила базы запрещают доступ");
      }
    );
    // Когда облако выключается, подписка должна отписаться.
    const off = unsubscribe;
    statusListeners.add(() => {
      try { off(); } catch (error) { /* уже отписались */ }
    });
    return off;
  } catch (error) {
    setCloud(false, "подписка не удалась");
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// Синхронизация состояния
// ---------------------------------------------------------------------------

/**
 * Общий раздел в базе. Внутри:
 *   clinica/settings  - настройки игрока
 *   clinica/rooms     - посещённые комнаты и открытые палаты
 *   clinica/progress  - игровой прогресс
 *   clinica/items/<roomId> - предметы комнат
 */
export const CLOUD_ROOT = "clinica";
