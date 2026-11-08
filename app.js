/**
 * Клиника v0.5 — игровая логика.
 *
 * Модульный скрипт, без сборщика: работает как есть на GitHub Pages.
 * Всё состояние живёт в GameState, который сам решает, писать в облако
 * или в localStorage.
 *
 * Управление гибридное:
 *   мышь    - наведение, клик по персонажу и предмету, перетаскивание;
 *   клавиатура - стрелки выбирают палату, Enter входит, Tab переключает
 *                персонажей и предметы, Esc закрывает панели.
 */

import { GameState } from "./game-state.js";
import { isCloud, cloudOn, cloudSet, CLOUD_ROOT } from "./firebase.js";

// ---------------------------------------------------------------------------
// Данные игры
// ---------------------------------------------------------------------------

const ROOMS = [
  {
    id: "1",
    no: "Палата №1",
    name: "Тихая палата",
    type: "одноместная",
    desc: "Койка застелена ровно, как будто её заправляли каждое утро. Под подушкой — записка, написанная дрожащей рукой.",
    actors: ["nadzornik"]
  },
  {
    id: "2",
    no: "Палата №2",
    name: "Двойная палата",
    type: "двухместная",
    desc: "Вторая койка пуста, но одеяло смято. Кто-то встал с него и не вернулся — или вернулся и ушёл снова.",
    actors: ["kuklotryapka", "kukla"]
  },
  {
    id: "3",
    no: "Палата №3",
    name: "Палата надворного",
    type: "одноместная",
    desc: "Окно заколочено фанерой. За фанерой слышно, как кто-то дышит — медленно, в такт часам на стене.",
    actors: ["perezholoshch"]
  },
  {
    id: "4",
    no: "Палата №4",
    name: "Процедурная",
    type: "пустая",
    desc: "Каталка, ремни, пятна на стене. Камеры в углах не выключены, но записи никто не смотрит.",
    actors: []
  }
];

const ACTORS = {
  nadzornik: {
    id: "nadzornik",
    name: "Передозолох",
    role: "санитар",
    icon: "☻",
    pitch: 0.45,
    rate: 0.8,
    lines: [
      "Не задерживайтесь. Здесь задерживаются.",
      "Вы записались? Нет? Значит, ещё один.",
      "Тихо. Тише. Вот так лучше.",
      "Я видел, как вы входили. Я всегда вижу.",
      "Дверь закрывается сама. Не привыкайте."
    ]
  },
  kuklotryapka: {
    id: "kuklotryapka",
    name: "Куклотряпка",
    role: "по совместительству — медсестра",
    icon: "✿",
    pitch: 1.15,
    rate: 0.9,
    lines: [
      "Здравствуйте! Вы к нам по записи или просто так?",
      "У нас тихо. Слишком тихо, если честно.",
      "Не смотрите на часы. Они здесь не работают.",
      "Я оставлю дверь открытой. На всякий случай.",
      "Если услышите смех — это не я. Я не смеюсь."
    ]
  },
  kukla: {
    id: "kukla",
    name: "Кукла",
    role: "пациентка",
    icon: "☾",
    pitch: 0.85,
    rate: 0.78,
    lines: [
      "Ты пахнешь коридором. Коридор пахнет мной. Значит, ты уже свой.",
      "Я считаю дни. Уже не помню, какие.",
      "Эту вещь оставили не просто так.",
      "Не выключай свет. Там темнота, а не комната.",
      "Мне снятся палаты, которых нет."
    ]
  },
  perezholoshch: {
    id: "perezholoshch",
    name: "Перезолош",
    role: "тот, кто говорит слишком тихо",
    icon: "◍",
    pitch: 0.6,
    rate: 0.85,
    lines: [
      "Тсс… ты слышишь? Вот это дыхание? Не моё.",
      "Я не шумел. Я просто стоял.",
      "Фанеру отбей. Там не окно. Там выход.",
      "Когда часы остановятся, уходи. Не оставляй предметы.",
      "Я оставил. Всё равно уходят."
    ]
  }
};

// ---------------------------------------------------------------------------
// Мелкие помощники
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3600);
}

function setStatus(kind, text) {
  ["statusChip", "statusChipRoom"].forEach((chipId) => {
    const chip = $(chipId);
    if (!chip) return;
    chip.classList.remove("ok", "offline", "error");
    if (kind) chip.classList.add(kind);
  });
  ["statusText", "statusTextRoom"].forEach((textId) => {
    const node = $(textId);
    if (node) node.textContent = text;
  });
}

// ---------------------------------------------------------------------------
// Звук: атмосфера и двери
// ---------------------------------------------------------------------------

const Sfx = (() => {
  let ctx = null;
  let master = null;

  function context() {
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
      master = ctx.createGain();
      master.gain.value = GameState.settings.masterVolume ?? 0.7;
      master.connect(ctx.destination);
    } catch (error) {
      ctx = null;
    }
    return ctx;
  }

  function noiseBuffer(seconds) {
    const audio = context();
    if (!audio) return null;
    const length = Math.floor(audio.sampleRate * seconds);
    const buffer = audio.createBuffer(1, length, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * Скрип двери: щелчок, скрип с изменяющейся частотой, глухой удар.
   * Каждый раз параметры случайные - один и тот же файл быстро надоедает.
   */
  function doorCreak() {
    if (GameState.settings.sound === false) return;
    const audio = context();
    if (!audio) return;

    const now = audio.currentTime;
    const rate = 0.88 + Math.random() * 0.24;
    const volume = 0.24 + Math.random() * 0.18;

    // 1. Щелчок замка.
    const click = audio.createOscillator();
    const clickGain = audio.createGain();
    click.type = "square";
    click.frequency.setValueAtTime(180 + Math.random() * 60, now);
    click.frequency.exponentialRampToValueAtTime(60, now + 0.07);
    clickGain.gain.setValueAtTime(volume * 0.5, now);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    click.connect(clickGain).connect(master);
    click.start(now);
    click.stop(now + 0.09);

    // 2. Скрип: шум через полосовой фильтр с плавающей частотой.
    const duration = 1.05 + Math.random() * 0.5;
    const buffer = noiseBuffer(duration);
    if (buffer) {
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;

      const band = audio.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 7 + Math.random() * 5;
      const base = 420 + Math.random() * 260;
      band.frequency.setValueAtTime(base, now);
      band.frequency.linearRampToValueAtTime(base * (1.5 + Math.random()), now + duration * 0.6);
      band.frequency.linearRampToValueAtTime(base * 0.7, now + duration);

      const gain = audio.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.1);
      gain.gain.setValueAtTime(volume, now + duration * 0.65);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      source.connect(band).connect(gain).connect(master);
      source.start(now);
      source.stop(now + duration);
    }

    // 3. Удар о косяк с низким гулом.
    const thump = audio.createOscillator();
    const thumpGain = audio.createGain();
    thump.type = "sine";
    thump.frequency.setValueAtTime(92, now + duration);
    thump.frequency.exponentialRampToValueAtTime(38, now + duration + 0.32);
    thumpGain.gain.setValueAtTime(volume * 0.85, now + duration);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + duration + 0.34);
    thump.connect(thumpGain).connect(master);
    thump.start(now + duration);
    thump.stop(now + duration + 0.36);
  }

  /**
   * Фоновая тишина палаты: едва слышный гул с редкими потрескиваниями.
   * Гул всегда один - предыдущий останавливается, иначе при каждом
   * входе в палату звук накапливался бы и становился всё громче.
   */
  let hum = null;
  let crackleTimer = null;

  function stopAmbience() {
    if (hum) {
      try {
        hum.gain.gain.cancelScheduledValues(hum.ctx.currentTime);
        hum.gain.gain.setValueAtTime(0.0001, hum.ctx.currentTime);
        hum.node.stop(hum.ctx.currentTime + 0.2);
      } catch (error) { /* уже остановлен */ }
      hum = null;
    }
    if (crackleTimer) {
      clearTimeout(crackleTimer);
      crackleTimer = null;
    }
  }

  function ambience() {
    stopAmbience();
    if (GameState.settings.sound === false) return;
    const audio = context();
    if (!audio) return;

    const now = audio.currentTime;
    const node = audio.createOscillator();
    const gain = audio.createGain();
    node.type = "sine";
    node.frequency.value = 47 + Math.random() * 9;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.035, now + 2.4);
    node.connect(gain).connect(master);
    node.start(now);
    hum = { node, gain, ctx: audio };

    // Потрескивания - редкие, непредсказуемые.
    const crackle = () => {
      if (GameState.settings.sound === false) return;
      const buffer = noiseBuffer(0.16);
      if (buffer) {
        const source = audio.createBufferSource();
        source.buffer = buffer;
        const filter = audio.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = 1400 + Math.random() * 2400;
        const crackGain = audio.createGain();
        crackGain.gain.setValueAtTime(0.02 + Math.random() * 0.05, audio.currentTime);
        crackGain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.16);
        source.connect(filter).connect(crackGain).connect(master);
        source.start();
      }
      crackleTimer = setTimeout(crackle, 3500 + Math.random() * 7000);
    };
    crackleTimer = setTimeout(crackle, 2200);
  }

  return {
    unlock: context,
    doorCreak,
    ambience,
    stopAmbience,
    setVolume(value) {
      if (master) master.gain.value = value;
    }
  };
})();

// ---------------------------------------------------------------------------
// Озвучка через Web Speech API
// ---------------------------------------------------------------------------

const Speech = (() => {
  let voices = [];

  // Синтезатор читаем при каждом обращении: браузер может подставить
  // его позже, и один раз вычисленный флаг остался бы неверным.
  function synth() {
    return window.speechSynthesis || null;
  }

  function isSupported() {
    return !!synth();
  }

  function loadVoices() {
    const engine = synth();
    if (!engine) return;
    voices = engine.getVoices() || [];
  }
  loadVoices();
  const engine = synth();
  if (engine && typeof engine.addEventListener === "function") {
    engine.addEventListener("voiceschanged", loadVoices);
  }

  function pickVoice() {
    if (!voices.length) loadVoices();
    const ru = voices.filter((voice) => /^ru(-|_)?/i.test(voice.lang || ""));
    return ru.find((voice) => voice.localService) || ru[0] || null;
  }

  function stop() {
    const engine = synth();
    if (!engine) return;
    try { engine.cancel(); } catch (error) { /* уже молчит */ }
  }

  /**
   * Произносит текст.
   * @param {string} text
   * @param {{pitch: number, rate: number}} profile
   */
  function speak(text, profile) {
    const engine = synth();
    if (!engine) {
      console.info("[Клиника] синтеза речи в браузере нет");
      return false;
    }
    if (GameState.settings.voice === false) {
      console.info("[Клиника] озвучка выключена в настройках");
      return false;
    }
    const clean = String(text || "").trim();
    if (!clean) return false;

    try {
      stop();
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = "ru-RU";
      const voice = pickVoice();
      if (voice) {
        try {
          utterance.voice = voice;
          utterance.lang = voice.lang || "ru-RU";
        } catch (error) {
          // Голос не принят браузером - оставляем язык, синтезатор
          // подберёт русский голос сам.
          console.info("[Клиника] голос не принят, оставляем lang:", error);
        }
      }
      utterance.pitch = profile?.pitch ?? 1;
      utterance.rate = profile?.rate ?? 1;
      utterance.volume = Math.min(1, Math.max(0, GameState.settings.masterVolume ?? 0.7));
      engine.speak(utterance);
      return true;
    } catch (error) {
      console.warn("[Клиника] озвучка не сработала:", error);
      return false;
    }
  }

  return { supported: isSupported, speak, stop };
})();

// ---------------------------------------------------------------------------
// Состояние вида
// ---------------------------------------------------------------------------

const state = {
  view: "corridor",
  roomId: null,
  selectedRoom: 0,
  selectedActor: 0,
  selectedItem: null,
  dialogActor: null,
  dialogLine: 0,
  items: {},
  itemsUnsub: null,
  settingsUnsub: null
};

// ---------------------------------------------------------------------------
// Темы
// ---------------------------------------------------------------------------

const THEMES = ["classic", "cold", "warm", "mono"];

function applyTheme(theme) {
  const key = THEMES.includes(theme) ? theme : "classic";
  document.documentElement.setAttribute("data-theme", key);
  return key;
}

// ---------------------------------------------------------------------------
// Коридор
// ---------------------------------------------------------------------------

function renderRooms() {
  const container = $("rooms");
  const visits = GameState.rooms.visited || {};
  container.innerHTML = "";

  ROOMS.forEach((room, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "room-card";
    card.setAttribute("role", "listitem");
    card.style.animationDelay = `${index * 70}ms`;
    card.dataset.index = String(index);

    const count = visits[room.id] || 0;
    card.innerHTML = `
      <span class="room-card__no">${room.no}</span>
      <span class="room-card__name">${room.name}</span>
      <span class="room-card__type">${room.type}</span>
      ${count ? `<span class="room-card__visits">заходов: ${count}</span>` : ""}
    `;

    card.addEventListener("click", () => {
      state.selectedRoom = index;
      enterRoom(room.id);
    });
    // Наведение меняет только выбор, карточки не пересоздаются -
    // иначе обработчик вызывал бы сам себя по кругу.
    card.addEventListener("mouseenter", () => selectRoom(index));
    container.appendChild(card);
  });

  highlightRoom();
}

/** Подсвечивает выбранную палату, не пересоздавая карточки. */
function selectRoom(index) {
  state.selectedRoom = (index + ROOMS.length) % ROOMS.length;
  highlightRoom();
}

function highlightRoom() {
  const cards = $("rooms").querySelectorAll(".room-card");
  cards.forEach((card, index) => {
    card.classList.toggle("room-card--current", index === state.selectedRoom);
  });
}

// ---------------------------------------------------------------------------
// Палата
// ---------------------------------------------------------------------------

function renderActors() {
  const container = $("actors");
  const room = ROOMS.find((item) => item.id === state.roomId);
  container.innerHTML = "";
  if (!room) return;

  room.actors.forEach((actorId, index) => {
    const actor = ACTORS[actorId];
    if (!actor) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "actor";
    button.style.left = `${24 + index * (52 / Math.max(1, room.actors.length - 1 || 1))}%`;
    button.style.bottom = `${24 + (index % 2) * 7}%`;
    button.setAttribute("aria-label", `${actor.name}, ${actor.role}`);
    button.innerHTML = `
      <span class="actor__figure"><span class="actor__icon">${actor.icon}</span></span>
      <span class="actor__name">${actor.name}</span>
    `;
    button.addEventListener("click", () => openDialog(actorId));
    container.appendChild(button);
  });
}

function enterRoom(roomId) {
  const room = ROOMS.find((item) => item.id === roomId);
  if (!room) return;

  state.roomId = roomId;
  state.selectedActor = 0;
  state.dialogActor = null;
  closeDialog();

  $("roomNo").textContent = room.no;
  $("roomType").textContent = room.type;
  $("roomDesc").textContent = room.desc;

  $("view-corridor").classList.remove("active");
  $("view-room").classList.add("active");
  state.view = "room";

  // Дверь скрипит, когда открывается.
  Sfx.doorCreak();
  Sfx.ambience();

  renderActors();
  GameState.markRoomVisited(roomId);

  subscribeRoomItems(roomId);
}

function showCorridor() {
  state.view = "corridor";
  state.roomId = null;
  closeDialog();
  Speech.stop();
  Sfx.stopAmbience();
  $("view-room").classList.remove("active");
  $("view-corridor").classList.add("active");
  renderRooms();
  if (state.itemsUnsub) {
    state.itemsUnsub();
    state.itemsUnsub = null;
  }
}

// ---------------------------------------------------------------------------
// Предметы
// ---------------------------------------------------------------------------

function subscribeRoomItems(roomId) {
  if (state.itemsUnsub) {
    state.itemsUnsub();
    state.itemsUnsub = null;
  }
  state.items = {};

  if (!isCloud()) {
    // Облака нет - показываем локальные предметы этой комнаты.
    const local = readLocalItems(roomId);
    state.items = local;
    renderItems();
    return;
  }

  state.itemsUnsub = cloudOn(`${CLOUD_ROOT}/items/${roomId}`, (value) => {
    state.items = value && typeof value === "object" ? value : {};
    renderItems();
  });
}

function readLocalItems(roomId) {
  try {
    const raw = localStorage.getItem("clinika.items.v05");
    if (!raw) return {};
    const all = JSON.parse(raw);
    return all && all[roomId] ? all[roomId] : {};
  } catch (error) {
    return {};
  }
}

function writeLocalItems(roomId, items) {
  try {
    const raw = localStorage.getItem("clinika.items.v05");
    const all = raw ? JSON.parse(raw) : {};
    all[roomId] = items;
    localStorage.setItem("clinika.items.v05", JSON.stringify(all));
  } catch (error) {
    console.warn("[Клиника] предметы не сохранились локально:", error);
  }
}

function renderItems() {
  const container = $("items");
  container.innerHTML = "";
  const items = state.items || {};

  Object.keys(items).forEach((itemId) => {
    const item = items[itemId];
    if (!item) return;

    const node = document.createElement("div");
    node.className = "item";
    if (state.selectedItem === itemId) node.classList.add("item--selected");
    node.dataset.itemId = itemId;
    node.style.left = `${clamp(Number(item.x) || 50, 4, 96)}%`;
    node.style.top = `${clamp(Number(item.y) || 50, 8, 92)}%`;
    node.style.transform = `translate(-50%, -50%) scale(${clamp(Number(item.scale) || 1, 0.4, 2.4)})`;

    const image = document.createElement("img");
    image.className = "item__image";
    image.src = item.url;
    image.alt = item.caption || "предмет";
    image.draggable = false;
    node.appendChild(image);

    if (item.caption) {
      const caption = document.createElement("div");
      caption.className = "item__caption";
      caption.textContent = item.caption;
      node.appendChild(caption);
    }

    const scaleBtn = document.createElement("button");
    scaleBtn.type = "button";
    scaleBtn.className = "item__scale";
    scaleBtn.textContent = "⤢";
    scaleBtn.title = "Изменить масштаб";
    scaleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedItem = itemId;
      renderItems();
    });
    node.appendChild(scaleBtn);

    node.addEventListener("click", () => {
      state.selectedItem = itemId;
      speakItem(item);
    });

    makeDraggable(node, itemId);
    container.appendChild(node);
  });
}

function speakItem(item) {
  const text = item.caption || "Предмет без подписи.";
  Speech.speak(text, { pitch: 0.6, rate: 0.85 });
}

/** Перетаскивание мышью. */
function makeDraggable(node, itemId) {
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.classList.contains("item__scale")) return;
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    const item = state.items[itemId] || {};
    originX = Number(item.x) || 50;
    originY = Number(item.y) || 50;
    node.setPointerCapture(event.pointerId);
    node.classList.add("item--dragging");
  });

  node.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;
    const nextX = clamp(originX + (dx / width) * 100, 4, 96);
    const nextY = clamp(originY + (dy / height) * 100, 8, 92);
    node.style.left = `${nextX}%`;
    node.style.top = `${nextY}%`;
  });

  const finish = (event) => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove("item--dragging");
    try { node.releasePointerCapture(event.pointerId); } catch (error) { /* уже отпущен */ }
    if (!moved) return;

    const item = state.items[itemId];
    if (!item) return;
    item.x = clamp(Number(node.style.left.replace("%", "")), 4, 96);
    item.y = clamp(Number(node.style.top.replace("%", "")), 8, 92);
    saveItem(itemId, item);
  };

  node.addEventListener("pointerup", finish);
  node.addEventListener("pointercancel", finish);
}

/** Сохраняет предмет: в облако, если оно есть, иначе локально. */
async function saveItem(itemId, item) {
  const roomId = state.roomId;
  if (!roomId) return;

  if (isCloud()) {
    try {
      await cloudSet(`${CLOUD_ROOT}/items/${roomId}/${itemId}`, item);
      return;
    } catch (error) {
      console.warn("[Клиника] предмет не ушёл в облако:", error);
    }
  }
  writeLocalItems(roomId, { ...(state.items || {}), [itemId]: item });
}

// ---------------------------------------------------------------------------
// Диалог
// ---------------------------------------------------------------------------

function openDialog(actorId) {
  const actor = ACTORS[actorId];
  if (!actor) return;
  state.dialogActor = actorId;
  state.dialogLine = 0;

  $("dialogPortrait").textContent = actor.icon;
  $("dialogName").textContent = actor.name;
  $("dialogRole").textContent = actor.role;
  $("dialogText").textContent = actor.lines[0];
  $("dialog").hidden = false;
  refreshSpeakButton();

  // Реплика произносится сразу и при каждом «Сказать ещё».
  Speech.speak(actor.lines[0], actor);
  GameState.markHeard(actorId);
  GameState.markDialogOpened(actorId);
}

function nextLine() {
  if (!state.dialogActor) return;
  const actor = ACTORS[state.dialogActor];
  state.dialogLine = (state.dialogLine + 1) % actor.lines.length;
  const line = actor.lines[state.dialogLine];
  $("dialogText").textContent = line;
  Speech.speak(line, actor);
  GameState.markHeard(actor.id);
}

function closeDialog() {
  const dialog = $("dialog");
  if (dialog) dialog.hidden = true;
  state.dialogActor = null;
}

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

function renderSettings(settings) {
  const value = Object.assign({}, GameState.defaults().settings, settings || {});
  $("themeSelect").value = value.theme;
  $("soundToggle").checked = value.sound !== false;
  $("voiceToggle").checked = value.voice !== false;
  $("motionToggle").checked = !!value.reduceMotion;
  $("volumeRange").value = value.masterVolume ?? 0.7;
  $("volumeOut").textContent = `${Math.round(Number(value.masterVolume ?? 0.7) * 100)}%`;
  $("settingsNote").textContent = isCloud()
    ? "Настройки и прогресс сохраняются в Firebase."
    : "Облако недоступно — настройки хранятся в этом браузере.";
  refreshSpeakButton();
}

// Кнопка «Повторить»: показывает, включена ли озвучка, и умеет включить её.
function refreshSpeakButton() {
  const btn = $("speakAgainBtn");
  if (!btn) return;
  btn.textContent = GameState.settings.voice === false
    ? "🔇 Озвучка выключена — включить"
    : "🔊 Повторить";
}

async function saveSetting(field, value) {
  await GameState.setSetting(field, value);

  if (field === "theme") applyTheme(value);
  if (field === "reduceMotion") {
    if (value) document.documentElement.setAttribute("data-reduce-motion", "1");
    else document.documentElement.removeAttribute("data-reduce-motion");
  }
  if (field === "masterVolume") Sfx.setVolume(value);
}

// ---------------------------------------------------------------------------
// Свой предмет
// ---------------------------------------------------------------------------

const MAX_EDGE = 1400;
const MAX_BYTES = 12 * 1024 * 1024;

let pendingFile = null;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Файл не удалось прочитать"));
    reader.readAsDataURL(file);
  });
}

/**
 * Убирает однотонный фон по краям картинки.
 *
 * Фон определяется по уменьшенной копии - иначе на картинке 1400x1400
 * цикл по пикселям занимал бы несколько секунд и подвешивал вкладку.
 * Найденная маска потом переносится на исходное изображение.
 */
function cutBackground(imageData) {
  const { data, width, height } = imageData;

  // 1. Уменьшенная копия для анализа цвета фона.
  const sampleSize = 160;
  const ratio = Math.min(1, sampleSize / Math.max(width, height));
  const sw = Math.max(1, Math.round(width * ratio));
  const sh = Math.max(1, Math.round(height * ratio));

  // drawImage() принимает картинку, а не ImageData. Поэтому сначала
  // кладём пиксели во временный canvas и уже его уменьшаем.
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext("2d");
  sourceContext.putImageData(imageData, 0, 0);

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0, sw, sh);
  const sample = context.getImageData(0, 0, sw, sh).data;

  // Усредняем углы - фон может быть слегка разным по краям.
  let r = 0, g = 0, b = 0, count = 0;
  const corners = [
    [0, 0], [sw - 1, 0], [0, sh - 1], [sw - 1, sh - 1],
    [Math.floor(sw / 2), 0], [Math.floor(sw / 2), sh - 1],
    [0, Math.floor(sh / 2)], [sw - 1, Math.floor(sh / 2)]
  ];
  corners.forEach(([x, y]) => {
    const i = (y * sw + x) * 4;
    r += sample[i]; g += sample[i + 1]; b += sample[i + 2]; count++;
  });
  const bg = [r / count, g / count, b / count];
  const tolerance = 38;

  // 2. Готовим маску прозрачности по уменьшенной копии.
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = sw;
  maskCanvas.height = sh;
  const maskContext = maskCanvas.getContext("2d");
  const maskImage = maskContext.createImageData(sw, sh);

  for (let i = 0; i < sample.length; i += 4) {
    const distance =
      Math.abs(sample[i] - bg[0]) +
      Math.abs(sample[i + 1] - bg[1]) +
      Math.abs(sample[i + 2] - bg[2]);
    maskImage.data[i] = 255;
    maskImage.data[i + 1] = 255;
    maskImage.data[i + 2] = 255;
    // Дальше от угла по цвету - тем меньше прозрачность, чтобы не
    // вырезать тени и полутоновые края предмета.
    maskImage.data[i + 3] = distance < tolerance ? 0 : 255;
  }
  maskContext.putImageData(maskImage, 0, 0);

  // 3. Переносим маску на исходное изображение.
  const scaled = context.getImageData(0, 0, sw, sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const si = (y * sw + x) * 4;
      const alpha = maskImage.data[si + 3];
      // На исходной картинке прозрачность ставим по блокам того же
      // масштаба - так быстрее, чем попиксельно.
      const x0 = Math.floor((x / sw) * width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) / sw) * width));
      const y0 = Math.floor((y / sh) * height);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) / sh) * height));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const di = (yy * width + xx) * 4;
          if (alpha === 0) data[di + 3] = 0;
        }
      }
    }
  }
  return imageData;
}

async function prepareFile(file) {
  if (!file) throw new Error("Файл не выбран");
  if (file.size > MAX_BYTES) throw new Error("Файл больше 12 МБ");

  const isGif = file.type === "image/gif";
  const dataUrl = await readAsDataUrl(file);

  if (isGif) {
    // GIF не трогаем - иначе пропадёт анимация.
    return { url: dataUrl, name: file.name, mime: file.type, cut: false };
  }

  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Картинка не открылась"));
    img.src = dataUrl;
  });

  const ratio = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
  const width = Math.round(image.width * ratio);
  const height = Math.round(image.height * ratio);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);

  let cut = false;
  try {
    const data = context.getImageData(0, 0, width, height);
    cutBackground(data);
    context.putImageData(data, 0, 0);
    cut = true;
    console.info("[Клиника] фон убран, размер", width + "x" + height);
  } catch (error) {
    // Если пиксели прочитать не дали - оставляем картинку как есть.
    console.warn("[Клиника] фон убрать не удалось:", error);
    cut = false;
  }

  return {
    url: canvas.toDataURL("image/png"),
    name: file.name,
    mime: "image/png",
    cut
  };
}

async function acceptFile(file) {
  if (!file) return;
  const drop = $("fileDrop");
  drop.classList.add("busy");
  $("fileDropTitle").textContent = "Обработка…";
  $("fileDropHint").textContent = "читаем файл и убираем фон";

  try {
    pendingFile = await prepareFile(file);
    $("filePreview").src = pendingFile.url;
    $("filePreview").hidden = false;
    drop.classList.add("has-file");
    $("fileDropTitle").textContent = pendingFile.name;
    $("fileDropHint").textContent = pendingFile.cut
      ? "фон убран — готово к вставке"
      : "готово к вставке";
  } catch (error) {
    pendingFile = null;
    showToast(error.message || "Файл не удалось подготовить", true);
    resetFile();
  } finally {
    drop.classList.remove("busy");
  }
}

function resetFile() {
  pendingFile = null;
  $("itemFile").value = "";
  $("filePreview").hidden = true;
  $("filePreview").removeAttribute("src");
  $("fileDrop").classList.remove("has-file");
  $("fileDropTitle").textContent = "Прикрепить файл";
  $("fileDropHint").textContent = "перетащите сюда или нажмите — JPG, PNG, WEBP, GIF";
}

async function placeItem() {
  if (!pendingFile) {
    showToast("Сначала прикрепите картинку или GIF", true);
    $("fileDrop").focus();
    return;
  }
  const roomId = state.roomId;
  if (!roomId) return;

  const itemId = `item_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const item = {
    url: pendingFile.url,
    caption: $("itemCaption").value.trim().slice(0, 80),
    x: 18 + Math.random() * 64,
    y: 26 + Math.random() * 46,
    scale: Number($("itemScale").value) || 1,
    fileName: pendingFile.name,
    mime: pendingFile.mime,
    cut: pendingFile.cut,
    createdAt: Date.now()
  };

  state.items = { ...(state.items || {}), [itemId]: item };
  renderItems();
  await saveItem(itemId, item);

  $("itemCaption").value = "";
  $("itemScale").value = "1";
  $("itemScaleOut").textContent = "1.00×";
  resetFile();
  $("itemPanel").hidden = true;

  GameState.countItemPlaced();
  showToast("Предмет поставлен. Его видят все, кто в палате.");
}

// ---------------------------------------------------------------------------
// Клавиатура
// ---------------------------------------------------------------------------

function onKeyDown(event) {
  const tag = document.activeElement?.tagName;
  const inField = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";

  if (event.key === "Escape") {
    if (!$("dialog").hidden) { closeDialog(); return; }
    if (!$("itemPanel").hidden) { $("itemPanel").hidden = true; return; }
    if (!$("settingsPanel").hidden) { $("settingsPanel").hidden = true; return; }
    if (state.view === "room") showCorridor();
    return;
  }

  if (inField) return;

  if (state.view === "corridor") {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectRoom(state.selectedRoom + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectRoom(state.selectedRoom - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      enterRoom(ROOMS[state.selectedRoom].id);
    }
    return;
  }

  if (state.view === "room") {
    const room = ROOMS.find((item) => item.id === state.roomId);
    const count = room ? room.actors.length : 0;
    // Tab оставляем браузеру: иначе игрок не смог бы дойти до кнопок.
    // Переключение персонажей - на цифрах 1..4.
    if (count && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < count) {
        event.preventDefault();
        state.selectedActor = index;
        openDialog(room.actors[index]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

function bindEvents() {
  $("settingsBtn").addEventListener("click", () => toggleSettings());
  $("settingsBtnRoom").addEventListener("click", () => toggleSettings());
  $("settingsCloseBtn").addEventListener("click", () => { $("settingsPanel").hidden = true; });
  $("backBtn").addEventListener("click", () => showCorridor());

  $("themeSelect").addEventListener("change", (e) => saveSetting("theme", e.target.value));
  $("soundToggle").addEventListener("change", (e) => saveSetting("sound", e.target.checked));
  $("voiceToggle").addEventListener("change", (e) => {
    saveSetting("voice", e.target.checked);
    if (!e.target.checked) Speech.stop();
  });
  $("motionToggle").addEventListener("change", (e) => saveSetting("reduceMotion", e.target.checked));
  $("volumeRange").addEventListener("input", (e) => {
    $("volumeOut").textContent = `${Math.round(Number(e.target.value) * 100)}%`;
  });
  $("volumeRange").addEventListener("change", (e) => saveSetting("masterVolume", Number(e.target.value)));

  $("togglePanelBtn").addEventListener("click", () => {
    $("itemPanel").hidden = !$("itemPanel").hidden;
    if (!$("itemPanel").hidden) {
      $("settingsPanel").hidden = true;
      $("fileDrop").focus();
    }
  });
  $("itemPanelCloseBtn").addEventListener("click", () => { $("itemPanel").hidden = true; });

  $("itemFile").addEventListener("change", (e) => acceptFile(e.target.files[0]));
  $("placeItemBtn").addEventListener("click", () => placeItem());
  $("itemScale").addEventListener("input", (e) => {
    $("itemScaleOut").textContent = `${Number(e.target.value).toFixed(2)}×`;
  });

  const drop = $("fileDrop");
  drop.addEventListener("click", () => $("itemFile").click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("itemFile").click();
    }
  });
  ["dragenter", "dragover"].forEach((type) => {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    });
  });
  drop.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) acceptFile(file);
  });

  $("dialogCloseBtn").addEventListener("click", () => closeDialog());
  $("dialogScrim").addEventListener("click", () => closeDialog());
  $("moreBtn").addEventListener("click", () => nextLine());
  $("speakAgainBtn").addEventListener("click", () => {
    if (!state.dialogActor) return;
    // Озвучку выключили в настройках? Кнопка сама её включает -
    // иначе игрок не понимает, почему игра молчит.
    if (GameState.settings.voice === false) {
      saveSetting("voice", true);
      refreshSpeakButton();
      showToast("Озвучка включена");
    }
    const actor = ACTORS[state.dialogActor];
    Speech.speak(actor.lines[state.dialogLine], actor);
  });

  document.addEventListener("keydown", onKeyDown);

  // Разблокировка звука после первого действия игрока.
  ["pointerdown", "keydown", "touchstart"].forEach((type) => {
    window.addEventListener(type, () => Sfx.unlock(), { once: true, passive: true });
  });
}

function toggleSettings() {
  const panel = $("settingsPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $("itemPanel").hidden = true;
    renderSettings(GameState.settings);
  }
}

async function start() {
  bindEvents();

  // Пока проверяем базу - показываем честный статус.
  setStatus("offline", "проверяем облако…");

  // Подтягиваем сохранённое состояние. Firebase внутри проверяет базу и
  // молча уходит в локальный режим, если её нет.
  const saved = await GameState.init();

  applyTheme(saved.settings.theme);
  if (saved.settings.reduceMotion) {
    document.documentElement.setAttribute("data-reduce-motion", "1");
  }
  renderSettings(saved.settings);
  renderRooms();

  // Статус честно показывает, где идёт синхронизация. Когда облако
  // возвращается - подтягиваем настройки и возобновляем подписку на
  // предметы текущей палаты.
  GameState.onStatus((cloud, settings) => {
    setStatus(
      cloud ? "ok" : "offline",
      cloud ? "Firebase: онлайн" : "локальный режим"
    );
    if (settings) {
      applyTheme(settings.theme);
      renderSettings(settings);
    }
    if (cloud && state.roomId) {
      subscribeRoomItems(state.roomId);
    }
  });

  // Живая подписка на настройки: если настройки поменяли в другой
  // вкладке или на другом устройстве - они применятся здесь.
  if (saved.cloud) {
    state.settingsUnsub = GameState.subscribe("settings", (settings) => {
      applyTheme(settings.theme);
      renderSettings(settings);
    });
  }

  setStatus(
    saved.cloud ? "ok" : "offline",
    saved.cloud ? "Firebase: онлайн" : "локальный режим"
  );

  // Предупреждение о незакрытом диалоге.
  window.addEventListener("beforeunload", () => Speech.stop());
}

start().catch((error) => {
  console.error("[Клиника] запуск не удался:", error);
  showToast("Что-то пошло не так. Обновите страницу.", true);
});
