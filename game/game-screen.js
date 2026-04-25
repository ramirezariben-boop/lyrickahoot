import { getSpeedBonus } from "../shared/utils.js";

const WS_URL =
  location.hostname === "localhost"
    ? "ws://localhost:3000"
    : "wss://lyrickahoot.onrender.com";

const HOST_AUTH_TOKEN_KEY = "HOST_AUTH_TOKEN";
const HOST_USER_KEY = "HOST_USER";
const ROOM_CODE_KEY = "ROOM_CODE";
const ALIVE_TTL_MS = 15_000;
const PRUNE_EVERY_MS = 3_000;
const MAX_MXP = 6;
const QUESTIONS_PER_GAME = 14;
const MAX_PTS_PER_QUESTION = 1500;
const MXP_FACTOR = MAX_MXP / (QUESTIONS_PER_GAME * MAX_PTS_PER_QUESTION);

const authOverlay = document.getElementById("hostAuthOverlay");
const hostIdInput = document.getElementById("hostIdInput");
const hostNipInput = document.getElementById("hostNipInput");
const hostLoginBtn = document.getElementById("hostLoginBtn");
const authError = document.getElementById("hostAuthError");
const roomCodeEl = document.getElementById("roomCode");
const statusEl = document.getElementById("status");
const exercisePickerEl = document.getElementById("exercisePicker");
const exerciseListEl = document.getElementById("exerciseList");
const exerciseToggleBtn = document.getElementById("exerciseToggleBtn");
const lyricsEl = document.getElementById("lyrics");
const rankingListEl = document.getElementById("rankingList");
const optionsListEl = document.getElementById("optionsList");
const hostQuestionStateEl = document.getElementById("hostQuestionState");
const playersModal = document.getElementById("playersModal");
const playersListEl = document.getElementById("playersList");

const hostButtons = [
  "repeatBtn",
  "resumeBtn",
  "closeBtn",
  "playersBtn",
  "editorBtn",
  "newGameBtn",
  "finishGameBtn",
].map((id) => document.getElementById(id));

let authToken = sessionStorage.getItem(HOST_AUTH_TOKEN_KEY) || "";
let hostUser = safeJsonParse(sessionStorage.getItem(HOST_USER_KEY));
let roomCode = sessionStorage.getItem(ROOM_CODE_KEY) || generateRoomCode();
let channel = null;
let player = null;
let exerciseList = [];
let selectedExercise = null;
let lyrics = null;
let exercise = null;
let gameTotals = {};
let lastSeen = new Map();
let connectedPlayers = new Set();
let playerNicknames = {};
let answers = {};
let answeredPlayers = new Set();
let expectedPlayers = new Set();
let openedQuestions = new Set();
let currentQuestionState = null;
let pendingQuestion = null;
let repeatWindow = null;
let previousLineId = null;
let currentLineId = null;
let finishingGame = false;
let hostReconnectTimeout = null;
let pendingQuestionTimer = null;
let autoAdvanceEnabled = true;
const AUTO_FADE_DELAY_MS = 1000;
const AUTO_FADE_DURATION_MS = 2500;
const AUTO_FADE_TARGET_VOLUME = 20;
let replayQuestionWindow = null;

roomCodeEl.textContent = `Código: ${roomCode}`;
sessionStorage.setItem(ROOM_CODE_KEY, roomCode);

boot();

function boot() {
  bindUi();
  setHostControlsEnabled(false);
  startIntervals();

  if (authToken) {
    authOverlay.classList.add("hidden");
    startHostApp();
    return;
  }

  authOverlay.classList.remove("hidden");
  hostIdInput.focus();
}

function bindUi() {
  hostLoginBtn.addEventListener("click", loginAsHost);
  hostNipInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") loginAsHost();
  });

  document.getElementById("playersBtn").addEventListener("click", () => {
    renderPlayersList();
    playersModal.classList.remove("hidden");
  });

  document.getElementById("closePlayersBtn").addEventListener("click", () => {
    playersModal.classList.add("hidden");
  });

  playersModal.addEventListener("click", (event) => {
    if (event.target === playersModal) {
      playersModal.classList.add("hidden");
    }
  });

  document.getElementById("repeatBtn").addEventListener("click", replayCurrentLine);
  document.getElementById("resumeBtn").addEventListener("click", resumePlayback);
  document.getElementById("closeBtn").addEventListener("click", closeQuestion);
  document.getElementById("nextBtn").addEventListener("click", nextQuestion);
  document.getElementById("newGameBtn").addEventListener("click", resetGameSession);
  document.getElementById("finishGameBtn").addEventListener("click", finishGame);
  document.getElementById("editorBtn").addEventListener("click", () => {
    if (!authToken) return;
    window.open("/editor/editor.html", "_blank", "noopener");
  });
  exerciseToggleBtn.addEventListener("click", toggleExercisePicker);

  window.onYouTubeIframeAPIReady = () => {
    initPlayer();
  };

  if (window.YT?.Player) {
    initPlayer();
  }
}

async function loginAsHost() {
  const id = hostIdInput.value.trim();
  const nip = hostNipInput.value.trim();

  if (!id || !nip) {
    showAuthError("Completa ID y NIP");
    return;
  }

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, nip, role: "host" }),
    });

    const data = await response.json();

    if (!response.ok || !data.ok || !data.canHost) {
      showAuthError("Esta cuenta no puede entrar como host");
      return;
    }

    authToken = data.authToken;
    hostUser = data.user;
    sessionStorage.setItem(HOST_AUTH_TOKEN_KEY, authToken);
    sessionStorage.setItem(HOST_USER_KEY, JSON.stringify(hostUser));
    authOverlay.classList.add("hidden");
    startHostApp();
  } catch (error) {
    console.error("Host login failed", error);
    showAuthError("No se pudo validar tu cuenta");
  }
}

function showAuthError(message) {
  authError.textContent = message;
  authError.style.display = "block";
}

function startHostApp() {
  if (!authToken) return;
  if (!channel || channel.readyState === WebSocket.CLOSED) {
    bindChannel();
  }
  loadExercises();
}

async function loadExercises() {
  try {
    const response = await fetch("/api/exercises");
    exerciseList = await response.json();
    renderExercisePicker();
    statusEl.textContent = "Selecciona un ejercicio para empezar";
  } catch (error) {
    console.error("Error loading exercises", error);
    statusEl.textContent = "No pude cargar los ejercicios";
  }
}

function renderExercisePicker() {
  exerciseListEl.innerHTML = "";

  if (exerciseList.length === 0) {
    exerciseListEl.textContent = "No hay ejercicios disponibles.";
    return;
  }

  exerciseList.forEach((item) => {
    const card = document.createElement("div");
    card.className = "exercise-card";

    const songLabel = item.song?.title
      ? `${item.song.title} — ${item.song.artist || "Desconocido"}`
      : item.songId;

    card.innerHTML = `
      <h4>${escapeHtml(item.name || item.file)}</h4>
      <p><strong>Canción:</strong> ${escapeHtml(songLabel)}</p>
      <p>${escapeHtml(item.description || "Sin descripción")}</p>
      <p><strong>Preguntas:</strong> ${item.questionWordIds?.length ?? 0}</p>
    `;

    const button = document.createElement("button");
    button.textContent = selectedExercise?.file === item.file ? "Seleccionado" : "Cargar ejercicio";
    button.disabled = selectedExercise?.file === item.file;
    button.addEventListener("click", () => selectExercise(item));
    card.appendChild(button);
    exerciseListEl.appendChild(card);
  });
}

async function selectExercise(item) {
  selectedExercise = item;
  renderExercisePicker();
  await loadSelectedExercise(item);
  setExercisePickerCollapsed(true);
}

async function loadSelectedExercise(item) {
  if (!item) return;

  statusEl.textContent = `Cargando ejercicio ${item.name || item.file}...`;
  setHostControlsEnabled(false);

  try {
    const songResponse = await fetch(`/api/song/${encodeURIComponent(item.songId)}`);
    if (!songResponse.ok) {
      throw new Error("No encontré la canción");
    }

    lyrics = await songResponse.json();
    exercise = {
      version: "1.0",
      type: "exercise",
      exercise: {
        id: item.id,
        songId: item.songId,
        name: item.name,
        description: item.description || "",
        questionWordIds: item.questionWordIds || [],
      },
    };

    previousLineId = null;
    currentLineId = null;
    clearPendingQuestion();
    currentQuestionState = null;
    answers = {};
    answeredPlayers = new Set();
    expectedPlayers = new Set();
    openedQuestions = new Set();
    optionsListEl.innerHTML = "";
    renderVisibleLines();
    renderRanking();

    if (player) {
      player.loadVideoById(lyrics.song.youtubeId);
      player.pauseVideo();
    }

    setHostControlsEnabled(true);
    statusEl.textContent = `Ejercicio listo: ${item.name}`;
  } catch (error) {
    console.error("Error loading selected exercise", error);
    statusEl.textContent = "No pude cargar ese ejercicio";
  }
}

function bindChannel() {
  try {
    channel?.close();
  } catch {
    // noop
  }

  channel = new WebSocket(WS_URL);

  channel.onopen = () => {
    clearTimeout(hostReconnectTimeout);
    channel.send(JSON.stringify({
      type: "HELLO",
      role: "HOST",
      roomCode,
      authToken,
    }));
  };

  channel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleSocketMessage(msg);
  };

  channel.onclose = () => {
    setHostControlsEnabled(false);
    statusEl.textContent = "Host desconectado. Intentando reconectar...";
    clearTimeout(hostReconnectTimeout);
    hostReconnectTimeout = setTimeout(() => {
      if (authToken) bindChannel();
    }, 1500);
  };
}

function handleSocketMessage(msg) {
  if (msg.type === "AUTH_ERROR") {
    clearHostSession();
    showAuthError("Tu sesión de host expiró. Vuelve a iniciar sesión.");
    authOverlay.classList.remove("hidden");
    return;
  }

  if (msg.type === "HOST_OK") {
    setHostControlsEnabled(Boolean(exercise));
    statusEl.textContent = exercise ? statusSummary() : "Sala lista. Falta elegir ejercicio.";
    return;
  }

  if (msg.type === "PLAYER_LEAVE") {
    removePlayer(msg.user);
    return;
  }

  if (msg.type === "PLAYER_JOIN" || msg.type === "PLAYER_REJOIN" || msg.type === "PLAYER_ALIVE") {
    touchPlayer(msg.user, msg.nickname, msg.emoji);
    return;
  }

  if (msg.type === "ANSWER") {
    handleAnswer(msg);
  }
}

function touchPlayer(userId, nickname, emoji) {
  if (userId === undefined || userId === null || String(userId).trim() === "") return;

  const normalizedUserId = String(userId);
  connectedPlayers.add(normalizedUserId);
  lastSeen.set(normalizedUserId, Date.now());
  playerNicknames[normalizedUserId] = {
    nickname: nickname || playerNicknames[normalizedUserId]?.nickname || `Jugador ${normalizedUserId}`,
    emoji: emoji || playerNicknames[normalizedUserId]?.emoji || "🙂",
  };

  renderPlayersList();
  updateStatus();
}

function removePlayer(userId) {
  if (userId === undefined || userId === null || String(userId).trim() === "") return;

  const normalizedUserId = String(userId);
  connectedPlayers.delete(normalizedUserId);
  lastSeen.delete(normalizedUserId);
  answeredPlayers.delete(normalizedUserId);
  delete answers[normalizedUserId];

  if (expectedPlayers.has(normalizedUserId)) {
    expectedPlayers.delete(normalizedUserId);
  }

  renderPlayersList();
  updateStatus();

  if (currentQuestionState && expectedPlayers.size > 0 && answeredPlayers.size >= expectedPlayers.size) {
    closeQuestion();
  }
}

function handleAnswer(msg) {
  if (msg.user === undefined || msg.user === null || String(msg.user).trim() === "") return;

  const userId = String(msg.user);

  if (!currentQuestionState || !expectedPlayers.has(userId) || answers[userId]) {
    return;
  }

  answers[userId] = msg;
  answeredPlayers.add(userId);
  updateStatus();

  if (expectedPlayers.size > 0 && answeredPlayers.size >= expectedPlayers.size) {
    closeQuestion();
  }
}

function renderPlayersList() {
  playersListEl.innerHTML = "";

  if (connectedPlayers.size === 0) {
    const li = document.createElement("li");
    li.textContent = "— No hay jugadores —";
    playersListEl.appendChild(li);
    return;
  }

  [...connectedPlayers]
    .sort((a, b) => Number(a) - Number(b))
    .forEach((userId) => {
      const info = playerNicknames[userId] || { nickname: `Jugador ${userId}`, emoji: "🙂" };
      const li = document.createElement("li");
      li.textContent = `${info.emoji} ${info.nickname}`;
      playersListEl.appendChild(li);
    });
}

function updateStatus() {
  statusEl.textContent = statusSummary();
}

function statusSummary() {
  if (!exercise) {
    return "Selecciona un ejercicio para empezar";
  }

  if (currentQuestionState) {
    hostQuestionStateEl.textContent = `Pregunta abierta: palabra #${currentQuestionState.wordId}.`;
    return `Respondieron ${answeredPlayers.size} / ${expectedPlayers.size}`;
  }

  hostQuestionStateEl.textContent = "Sin pregunta abierta.";

  if (connectedPlayers.size === 0) {
    return "Esperando jugadores...";
  }

  return `Sala activa. ${connectedPlayers.size} jugador(es) conectados`;
}

function setHostControlsEnabled(enabled) {
  hostButtons.forEach((button) => {
    if (!button) return;
    button.disabled = !enabled;
    button.style.opacity = enabled ? "1" : "0.4";
    button.style.pointerEvents = enabled ? "auto" : "none";
  });
}

function initPlayer() {
  if (player || !window.YT?.Player) return;

  player = new window.YT.Player("player", {
    height: "315",
    width: "560",
    videoId: lyrics?.song?.youtubeId || "",
    playerVars: {
      controls: 1,
      enablejsapi: 1,
      origin: window.location.origin,
      rel: 0,
      playsinline: 1,
    },
    events: {
      onReady: () => {
        setInterval(checkVideoTime, 200);
      },
    },
  });
}

function checkVideoTime() {
  if (!player || !lyrics) return;

  const currentTime = player.getCurrentTime();
  syncCurrentLine(currentTime);
  highlightCurrentWord(currentTime);

  if (autoAdvanceEnabled && !currentQuestionState && !pendingQuestion) {
    maybeAutoOpenQuestion(currentTime);
  }

  if (pendingQuestion?.mode === "auto") {
    processAutoQuestionFade(currentTime);
  }

  if (replayQuestionWindow) {
    processReplayQuestionWindow(currentTime);
  }

  if (repeatWindow && currentTime >= repeatWindow.end) {
    repeatWindow = null;
    player.pauseVideo();
  }

}

function syncCurrentLine(currentTime) {
  const line = getCurrentLineByTime(currentTime);
  if (!line || line.id === currentLineId) return;

  previousLineId = currentLineId;
  currentLineId = line.id;
  renderVisibleLines();
}

function renderVisibleLines() {
  lyricsEl.innerHTML = "";

  if (!lyrics) return;

  const linesToShow = [];
  if (previousLineId) linesToShow.push(previousLineId);
  if (currentLineId) linesToShow.push(currentLineId);

  if (linesToShow.length === 0 && lyrics.lines[0]) {
    linesToShow.push(lyrics.lines[0].id);
  }

  linesToShow.forEach((lineId) => {
    const line = lyrics.lines.find((item) => item.id === lineId);
    if (!line) return;

    const div = document.createElement("div");
    div.className = "line";
    if (lineId === currentLineId) {
      div.classList.add("active");
    }

    line.wordIds.forEach((wordId) => {
      const word = lyrics.words.find((item) => item.id === wordId);
      if (!word) return;

      const span = document.createElement("span");
      span.className = "word";
      span.dataset.wordId = String(word.id);
      span.textContent = exercise?.exercise.questionWordIds.includes(word.id) ? "[ ... ]" : word.text;
      div.appendChild(span);
      div.append(" ");
    });

    lyricsEl.appendChild(div);
  });
}

function getCurrentLineByTime(time) {
  if (!lyrics) return null;

  for (let index = 0; index < lyrics.lines.length; index += 1) {
    const line = lyrics.lines[index];
    const firstWord = getWord(line.wordIds[0]);
    const nextLine = lyrics.lines[index + 1];
    const nextFirstWord = nextLine ? getWord(nextLine.wordIds[0]) : null;

    if (!firstWord) continue;

    const start = firstWord.time;
    const end = nextFirstWord ? nextFirstWord.time : Number.POSITIVE_INFINITY;

    if (time >= start && time < end) {
      return line;
    }
  }

  return null;
}

function highlightCurrentWord(currentTime) {
  if (!currentLineId) return;

  const line = lyrics.lines.find((item) => item.id === currentLineId);
  if (!line) return;

  let activeWordId = null;

  for (let index = 0; index < line.wordIds.length; index += 1) {
    const word = getWord(line.wordIds[index]);
    const nextWord = getWord(line.wordIds[index + 1]);
    if (!word) continue;

    const start = word.time;
    const end = nextWord ? nextWord.time : start + 1;
    if (currentTime >= start && currentTime < end) {
      activeWordId = word.id;
      break;
    }
  }

  document.querySelectorAll(".word").forEach((span) => {
    span.classList.toggle("active", Number(span.dataset.wordId) === activeWordId);
  });
}

function openPreparedQuestion() {
  if (!pendingQuestion) return;

  try {
    if (pendingQuestion.mode !== "manual" && player?.setVolume) {
      player.setVolume(Number(pendingQuestion.baseVolume ?? 100));
    }
    player?.pauseVideo();
  } catch (error) {
    console.warn("No se pudo pausar el video al abrir pregunta", error);
  }

  openedQuestions.add(pendingQuestion.wordId);
  answers = {};
  answeredPlayers = new Set();
  expectedPlayers = new Set(connectedPlayers);

  currentQuestionState = {
    wordId: pendingQuestion.wordId,
    openedAt: Date.now(),
    options: pendingQuestion.options,
  };

  renderOptionsPreview(currentQuestionState.options);
  sendHostBroadcast({
    type: "OPEN",
    wordId: currentQuestionState.wordId,
    openedAt: currentQuestionState.openedAt,
    options: currentQuestionState.options,
    currentLineId,
  });

  console.info("OPEN sent", currentQuestionState);

  pendingQuestion = null;
  updateStatus();
}

function maybeAutoOpenQuestion(currentTime) {
  const nextWordId = getNextUnopenedQuestionWordId();
  if (!nextWordId) return;

  const targetWord = getWord(nextWordId);
  if (!targetWord || typeof targetWord.time !== "number") return;

  if (currentTime < targetWord.time) return;

  const nextWordInSong = getNextWordInSong(nextWordId);
  const fadeStartTime = targetWord.time + AUTO_FADE_DELAY_MS / 1000;
  const pauseTime = fadeStartTime + AUTO_FADE_DURATION_MS / 1000;

  pendingQuestion = {
    wordId: nextWordId,
    options: generateOptions(nextWordId),
    mode: "auto",
    targetWordTime: targetWord.time,
    fadeStartTime,
    pauseTime: nextWordInSong
      ? Math.max(pauseTime, Math.min(nextWordInSong.time + 0.15, fadeStartTime + 3.5))
      : pauseTime,
    baseVolume: Number(player?.getVolume?.() ?? 100),
  };

  processAutoQuestionFade(currentTime);
}

function closeQuestion() {
  if (!currentQuestionState) return;

  const { wordId, openedAt } = currentQuestionState;
  const correctText = normalizeWord(getWord(wordId)?.text || "");

  const scores = Object.fromEntries(
    Object.entries(answers).map(([userId, answer]) => {
      const isCorrect = normalizeWord(answer.answer) === correctText;
      const elapsed = Math.max(0, Number(answer.timestamp) - openedAt);
      const bonus = isCorrect ? getSpeedBonus(elapsed) : 0;
      gameTotals[userId] = (gameTotals[userId] || 0) + bonus;
      return [userId, bonus];
    })
  );

  sendHostBroadcast({ type: "QUESTION_RESULT", scores });
  sendHostBroadcast({ type: "CLOSE" });

  currentQuestionState = null;
  answers = {};
  answeredPlayers = new Set();
  expectedPlayers = new Set();
  renderRanking();
  updateStatus();
}

function nextQuestion() {
  if (currentQuestionState) {
    closeQuestion();
  }

  const nextWordId = getNextUnopenedQuestionWordId();
  if (!nextWordId) {
    setStatus("No hay más preguntas.");
    return;
  }

  // Preparar pregunta manual
  const targetWord = getWord(nextWordId);
  const nextWordInSong = getNextWordInSong(nextWordId);

  pendingQuestion = {
    wordId: nextWordId,
    options: generateOptions(nextWordId),
    mode: "manual",
    targetWordTime: targetWord.time,
    fadeStartTime: targetWord.time, // inmediato
    pauseTime: nextWordInSong
      ? Math.min(nextWordInSong.time + 0.15, targetWord.time + 3.5)
      : targetWord.time + 3.5,
    baseVolume: Number(player?.getVolume?.() ?? 100),
  };

  openPreparedQuestion();
}

function replayCurrentLine() {
  if (!player || !lyrics) return;

  if (currentQuestionState) {
    replayCurrentQuestionSegment();
    return;
  }

  const targetWordId = currentQuestionState?.wordId || pendingQuestion?.wordId;
  const line = targetWordId ? findLineByWordId(targetWordId) : lyrics.lines.find((item) => item.id === currentLineId);
  if (!line) return;

  const lineIndex = lyrics.lines.findIndex((item) => item.id === line.id);
  const firstWord = getWord(line.wordIds[0]);
  const nextLine = lyrics.lines[lineIndex + 1];
  const nextFirstWord = nextLine ? getWord(nextLine.wordIds[0]) : null;
  const end = nextFirstWord ? nextFirstWord.time - 0.15 : firstWord.time + 3;

  repeatWindow = { end };
  player.seekTo(Math.max(0, firstWord.time - 2), true);
  player.playVideo();
}

function replayCurrentQuestionSegment() {
  const wordId = currentQuestionState?.wordId;
  if (!wordId) return;

  const targetWord = getWord(wordId);
  if (!targetWord || typeof targetWord.time !== "number") return;

  const line = findLineByWordId(wordId);
  const lineFirstWord = line ? getWord(line.wordIds[0]) : null;
  const seekTime = Math.max(0, (lineFirstWord?.time ?? targetWord.time) - 0.45);
  const fadeStartTime = targetWord.time + AUTO_FADE_DELAY_MS / 1000;
  const pauseTime = fadeStartTime + AUTO_FADE_DURATION_MS / 1000;

  replayQuestionWindow = {
    wordId,
    fadeStartTime,
    pauseTime,
    baseVolume: Number(player?.getVolume?.() ?? 100),
  };

  try {
    if (player?.setVolume) {
      player.setVolume(replayQuestionWindow.baseVolume);
    }
    player.seekTo(seekTime, true);
    player.playVideo();
  } catch (error) {
    console.warn("No se pudo repetir el fragmento de la pregunta actual", error);
    replayQuestionWindow = null;
  }
}

function resumePlayback() {
  if (!player || pendingQuestion || currentQuestionState) return;
  player.playVideo();
  updateStatus();
}

function renderRanking() {
  rankingListEl.innerHTML = "";

  const entries = Object.entries(gameTotals)
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA);

  entries.slice(0, connectedPlayers.size < 10 ? 3 : 5).forEach(([userId, score]) => {
    const li = document.createElement("li");
    const playerInfo = playerNicknames[userId] || { nickname: `Jugador ${userId}`, emoji: "🙂" };
    li.textContent = `${playerInfo.emoji} ${playerInfo.nickname} — ${score} pts`;
    rankingListEl.appendChild(li);
  });
}

function renderOptionsPreview(options) {
  optionsListEl.innerHTML = "";
  options.forEach((option) => {
    const li = document.createElement("li");
    li.textContent = option;
    optionsListEl.appendChild(li);
  });
}

function startIntervals() {
  setInterval(() => {
    const cutoff = Date.now() - ALIVE_TTL_MS;
    [...connectedPlayers].forEach((userId) => {
      if ((lastSeen.get(userId) || 0) < cutoff) {
        removePlayer(userId);
      }
    });
  }, PRUNE_EVERY_MS);
}

function sendHostBroadcast(payload) {
  if (!channel || channel.readyState !== WebSocket.OPEN) return;
  channel.send(JSON.stringify({ type: "HOST_BROADCAST", payload }));
}

function resetGameSession() {
  if (!confirm("¿Crear una nueva sala y sacar a todos los jugadores actuales?")) {
    return;
  }

  sendHostBroadcast({ type: "GAME_RESET" });
  resetRoomState("Sala nueva lista.");
}

function normalizeChanges(changes) {
  const map = {};
  changes.forEach(({ id, delta }) => {
    map[id] = (map[id] || 0) + delta;
  });
  return Object.entries(map).map(([id, delta]) => ({ id, delta }));
}

function computeMxpChanges() {
  return normalizeChanges(
    Object.entries(gameTotals).map(([id, points]) => ({
      id,
      delta: Math.min(MAX_MXP, Math.round(points * MXP_FACTOR * 100) / 100),
    }))
  );
}

async function finishGame() {
  if (finishingGame) return;
  if (!confirm("¿Finalizar juego y pagar MXP?")) return;

  const changes = computeMxpChanges();
  if (changes.length === 0) {
    alert("No hay puntos acumulados para pagar.");
    return;
  }

  finishingGame = true;
  setHostControlsEnabled(false);

  try {
    const response = await fetch("/api/pay-mxp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ changes }),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    sendHostBroadcast({ type: "GAME_RESET" });
    gameTotals = {};
    renderRanking();
    resetRoomState("Juego pagado y sala reiniciada.");
  } catch (error) {
    console.error("Error paying MXP", error);
    alert("Falló el pago MXP. La sala sigue abierta.");
    setHostControlsEnabled(Boolean(exercise));
  } finally {
    finishingGame = false;
  }
}

function resetRoomState(message) {
  roomCode = generateRoomCode();
  sessionStorage.setItem(ROOM_CODE_KEY, roomCode);
  roomCodeEl.textContent = `Código: ${roomCode}`;

  answers = {};
  answeredPlayers = new Set();
  expectedPlayers = new Set();
  currentQuestionState = null;
  clearPendingQuestion();
  connectedPlayers = new Set();
  playerNicknames = {};
  lastSeen = new Map();
  gameTotals = {};
  openedQuestions = new Set();
  renderRanking();
  renderPlayersList();
  statusEl.textContent = message;
  bindChannel();
}

function clearPendingQuestion() {
  pendingQuestion = null;
  clearTimeout(pendingQuestionTimer);
  pendingQuestionTimer = null;
  hostQuestionStateEl.textContent = "Sin pregunta abierta.";
  replayQuestionWindow = null;
  if (player?.setVolume) {
    try {
      player.setVolume(100);
    } catch {
      // noop
    }
  }
}

function getNextUnopenedQuestionWordId() {
  return exercise?.exercise.questionWordIds.find((wordId) => !openedQuestions.has(wordId)) ?? null;
}

function getNextWordInSong(wordId) {
  if (!lyrics?.words?.length) return null;
  const index = lyrics.words.findIndex((word) => word.id === wordId);
  if (index < 0) return null;
  return lyrics.words[index + 1] ?? null;
}

function processAutoQuestionFade(currentTime) {
  if (!pendingQuestion || pendingQuestion.mode !== "auto") return;

  const {
    fadeStartTime,
    pauseTime,
    baseVolume = 100,
  } = pendingQuestion;

  if (currentTime < fadeStartTime) {
    return;
  }

  if (currentTime >= pauseTime) {
    if (player?.setVolume) {
      try {
        player.setVolume(baseVolume);
      } catch {
        // noop
      }
    }
    openPreparedQuestion();
    return;
  }

  const progress = Math.min(1, Math.max(0, (currentTime - fadeStartTime) / (pauseTime - fadeStartTime)));
  const targetVolume = Math.round(baseVolume - ((baseVolume - AUTO_FADE_TARGET_VOLUME) * progress));

  if (player?.setVolume) {
    try {
      player.setVolume(targetVolume);
    } catch {
      // noop
    }
  }

  hostQuestionStateEl.textContent = `Bajando volumen para pregunta #${pendingQuestion.wordId}...`;
}

function processReplayQuestionWindow(currentTime) {
  if (!replayQuestionWindow) return;

  const {
    wordId,
    fadeStartTime,
    pauseTime,
    baseVolume = 100,
  } = replayQuestionWindow;

  if (currentTime < fadeStartTime) {
    return;
  }

  if (currentTime >= pauseTime) {
    try {
      if (player?.setVolume) {
        player.setVolume(baseVolume);
      }
      player?.pauseVideo();
    } catch {
      // noop
    }
    replayQuestionWindow = null;
    hostQuestionStateEl.textContent = `Pregunta abierta: palabra #${wordId}.`;
    return;
  }

  const progress = Math.min(1, Math.max(0, (currentTime - fadeStartTime) / (pauseTime - fadeStartTime)));
  const targetVolume = Math.round(baseVolume - ((baseVolume - AUTO_FADE_TARGET_VOLUME) * progress));

  try {
    if (player?.setVolume) {
      player.setVolume(targetVolume);
    }
  } catch {
    // noop
  }

  hostQuestionStateEl.textContent = `Repitiendo pregunta #${wordId}...`;
}

function generateOptions(correctWordId, count = 4) {
  const correctWord = getWord(correctWordId);
  if (!correctWord) return [];

  const pool = [...new Set(
    lyrics.words
      .filter((word) => word.id !== correctWordId)
      .map((word) => word.text)
  )];

  const distractors = [];
  while (distractors.length < count - 1 && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    distractors.push(pool.splice(index, 1)[0]);
  }

  const options = [correctWord.text, ...distractors];
  shuffle(options);
  return options;
}

function findLineByWordId(wordId) {
  return lyrics?.lines.find((line) => line.wordIds.includes(wordId)) || null;
}

function getWord(wordId) {
  return lyrics?.words.find((word) => word.id === wordId) || null;
}

function normalizeWord(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function shuffle(array) {
  for (let index = array.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [array[index], array[randomIndex]] = [array[randomIndex], array[index]];
  }
}

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clearHostSession() {
  authToken = "";
  hostUser = null;
  sessionStorage.removeItem(HOST_AUTH_TOKEN_KEY);
  sessionStorage.removeItem(HOST_USER_KEY);
}

function toggleExercisePicker() {
  const collapsed = !exercisePickerEl.classList.contains("collapsed");
  setExercisePickerCollapsed(collapsed);
}

function setExercisePickerCollapsed(collapsed) {
  exercisePickerEl.classList.toggle("collapsed", collapsed);
  exerciseToggleBtn.textContent = collapsed ? "Expandir" : "Minimizar";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
