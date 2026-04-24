const HOST_AUTH_TOKEN_KEY = "HOST_AUTH_TOKEN";
const authToken = sessionStorage.getItem(HOST_AUTH_TOKEN_KEY) || "";

const lockedView = document.getElementById("lockedView");
const editorApp = document.getElementById("editorApp");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const linesContainer = document.getElementById("linesContainer");
const lyricsScrollEl = document.querySelector(".lyrics-scroll");

const songTitleInput = document.getElementById("songTitle");
const songArtistInput = document.getElementById("songArtist");
const youtubeIdInput = document.getElementById("youtubeId");
const songIdInput = document.getElementById("songId");
const exerciseNameInput = document.getElementById("exerciseName");
const exerciseDescriptionInput = document.getElementById("exerciseDescription");
const lyricsInput = document.getElementById("lyricsInput");
const buildBtn = document.getElementById("buildBtn");
const saveSongBtn = document.getElementById("saveSongBtn");
const saveExerciseBtn = document.getElementById("saveExerciseBtn");
const loadSongBtn = document.getElementById("loadSongBtn");
const loadSongInput = document.getElementById("loadSongInput");
const selectAllBtn = document.getElementById("selectAllBtn");
const clearQuestionsBtn = document.getElementById("clearQuestionsBtn");
const modeQuestionBtn = document.getElementById("modeQuestionBtn");
const modeTimingBtn = document.getElementById("modeTimingBtn");
const timingWordBtn = document.getElementById("timingWordBtn");
const timingLineBtn = document.getElementById("timingLineBtn");
const syncStartBtn = document.getElementById("syncStartBtn");
const markEndBtn = document.getElementById("markEndBtn");
const replayLineBtn = document.getElementById("replayLineBtn");
const followBtn = document.getElementById("followBtn");

let player = null;
let lineModels = [];
let questionWordIds = new Set();
let youtubeApiPromise = null;
let clickMode = "question";
let timingMode = "word";
let selectedLineId = null;
let currentPlaybackLineId = null;
let followPlayback = false;

if (!authToken) {
  lockedView.style.display = "block";
} else {
  editorApp.style.display = "block";
  bindUi();
}

function bindUi() {
  buildBtn.addEventListener("click", () => {
    buildLineModels().catch((error) => {
      console.error("Error preparing lines", error);
      setStatus("No pude preparar las líneas.", "error");
    });
  });
  saveSongBtn.addEventListener("click", saveSong);
  saveExerciseBtn.addEventListener("click", saveExercise);
  loadSongBtn.addEventListener("click", () => loadSongInput.click());
  loadSongInput.addEventListener("change", loadSong);
  selectAllBtn.addEventListener("click", selectAllQuestionWords);
  clearQuestionsBtn.addEventListener("click", clearQuestionWords);
  youtubeIdInput.addEventListener("change", () => void syncVideoFromInput());
  youtubeIdInput.addEventListener("blur", () => void syncVideoFromInput());
  modeQuestionBtn.addEventListener("click", () => setClickMode("question"));
  modeTimingBtn.addEventListener("click", () => setClickMode("timing"));
  timingWordBtn.addEventListener("click", () => setTimingMode("word"));
  timingLineBtn.addEventListener("click", () => setTimingMode("line"));
  syncStartBtn.addEventListener("click", syncSelectedLineStart);
  markEndBtn.addEventListener("click", markSelectedLineEnd);
  replayLineBtn.addEventListener("click", replaySelectedLine);
  followBtn.addEventListener("click", toggleFollowPlayback);

  void ensurePlayerReady();
  syncToolbarState();
}

async function ensurePlayerReady() {
  await loadYouTubeApi();

  if (player) {
    return player;
  }

  player = await createPlayer();
  setStatus("Video listo para sincronizar.", "success");
  await syncVideoFromInput();
  return player;
}

async function buildLineModels() {
  const rawLines = lyricsInput.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (rawLines.length === 0) {
    setStatus("Pega la letra antes de preparar las líneas.", "error");
    return;
  }

  lineModels = rawLines.map((text, index) => ({
    id: index + 1,
    text,
    startTime: null,
    endTime: null,
    tokens: tokenizeLine(text),
    wordTimes: tokenizeLine(text).map(() => null),
  }));

  questionWordIds = new Set();
  selectedLineId = lineModels[0]?.id ?? null;
  renderLines();
  setStatus("Líneas listas. Ahora marca los tiempos y las palabras pregunta.", "success");
  await syncVideoFromInput();
}

function renderLines() {
  linesContainer.innerHTML = "";

  if (lineModels.length === 0) {
    summaryEl.textContent = "Sin líneas preparadas todavía.";
    return;
  }

  lineModels.forEach((lineModel) => {
    const card = document.createElement("article");
    card.className = "line-row";
    card.classList.toggle("selected", lineModel.id === selectedLineId);
    card.classList.toggle("playing", lineModel.id === currentPlaybackLineId);
    card.dataset.lineId = String(lineModel.id);
    card.addEventListener("click", (event) => {
      if (event.target.closest(".word-chip") || event.target.closest(".line-end-btn") || event.target.closest(".secondary")) {
        return;
      }
      selectedLineId = lineModel.id;

      if (clickMode === "timing" && timingMode === "line") {
        if (!player?.getCurrentTime) {
          setStatus("El video aún no está listo.", "error");
          return;
        }
        setLineStartTime(lineModel, Number(player.getCurrentTime().toFixed(2)));
        setStatus(`Inicio de la línea ${lineModel.id}: ${lineModel.startTime.toFixed(2)} s`, "success");
      }

      renderLines();
    });

    const header = document.createElement("div");
    header.className = "line-row-header";

    const title = document.createElement("div");
    title.className = "line-row-title";
    title.innerHTML = `<strong>Línea ${lineModel.id}</strong>`;

    const actions = document.createElement("div");
    actions.className = "line-times";
    actions.innerHTML = `
      <span>Inicio: ${lineModel.startTime == null ? "—" : `${lineModel.startTime.toFixed(2)} s`}</span>
      <span>Fin: ${lineModel.endTime == null ? "auto" : `${lineModel.endTime.toFixed(2)} s`}</span>
    `;

    header.appendChild(title);
    header.appendChild(actions);
    card.appendChild(header);

    const preview = document.createElement("p");
    preview.className = "line-row-text";
    preview.textContent = lineModel.text;
    card.appendChild(preview);

    const stats = document.createElement("div");
    stats.className = "summary-row";

    const selectedCount = lineModel.tokens.filter((_, tokenIndex) => {
      const tempKey = buildTempWordKey(lineModel.id, tokenIndex);
      return questionWordIds.has(tempKey);
    }).length;

    const timedWords = lineModel.wordTimes.filter((time) => typeof time === "number").length;

    stats.innerHTML = `
      <span class="mini-pill">${selectedCount} palabra(s) pregunta</span>
      <span class="mini-pill">${timedWords}/${lineModel.tokens.length} con tiempo manual</span>
      <span class="mini-pill">${lineModel.endTime == null ? "Fin automático" : `Fin ${lineModel.endTime.toFixed(2)} s`}</span>
    `;
    card.appendChild(stats);

    const wordsBox = document.createElement("div");
    wordsBox.className = "word-grid";
    lineModel.tokens.forEach((token, tokenIndex) => {
      const tempKey = buildTempWordKey(lineModel.id, tokenIndex);
      const wordEditor = document.createElement("div");
      wordEditor.className = "word-editor";
      wordEditor.classList.toggle("selected", questionWordIds.has(tempKey));

      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "word-chip";
      chip.textContent = token;
      chip.classList.toggle("selected", questionWordIds.has(tempKey));
      chip.addEventListener("click", () => {
        selectedLineId = lineModel.id;
        if (clickMode === "timing") {
          if (timingMode !== "word") {
            if (!player?.getCurrentTime) {
              setStatus("El video aún no está listo.", "error");
              return;
            }
            setLineStartTime(lineModel, Number(player.getCurrentTime().toFixed(2)));
            setStatus(`Inicio de la línea ${lineModel.id}: ${lineModel.startTime.toFixed(2)} s`, "success");
            renderLines();
            return;
          }
          if (!player?.getCurrentTime) {
            setStatus("El video aún no está listo.", "error");
            return;
          }
          lineModel.wordTimes[tokenIndex] = Number(player.getCurrentTime().toFixed(2));
        } else {
          if (questionWordIds.has(tempKey)) {
            questionWordIds.delete(tempKey);
          } else {
            questionWordIds.add(tempKey);
          }
        }
        renderLines();
      });

      const meta = document.createElement("div");
      meta.className = "word-meta";

      const timeLabel = document.createElement("span");
      const wordTime = lineModel.wordTimes[tokenIndex];
      timeLabel.textContent = typeof wordTime === "number" ? `${wordTime.toFixed(2)} s` : "Auto";

      meta.appendChild(timeLabel);
      if (timingMode === "word") {
        const hint = document.createElement("span");
        hint.textContent = clickMode === "timing" ? "Click=tiempo" : "Click=pregunta";
        meta.appendChild(hint);
      }
      wordEditor.appendChild(chip);
      wordEditor.appendChild(meta);
      wordsBox.appendChild(wordEditor);
    });
    card.appendChild(wordsBox);

    if (timingMode === "line") {
      const lineEndRow = document.createElement("div");
      lineEndRow.className = "line-end-row";

      const endLabel = document.createElement("span");
      endLabel.textContent = lineModel.endTime == null
        ? "Sin fin manual: continúa con la siguiente frase"
        : `Fin de frase: ${lineModel.endTime.toFixed(2)} s`;

      const endBtn = document.createElement("button");
      endBtn.type = "button";
      endBtn.className = "line-end-btn";
      endBtn.textContent = "Marcar fin de frase";
      endBtn.addEventListener("click", () => {
        if (!player?.getCurrentTime) {
          setStatus("El video aún no está listo.", "error");
          return;
        }
        selectedLineId = lineModel.id;
        lineModel.endTime = Number(player.getCurrentTime().toFixed(2));
        setStatus(`Fin de la línea ${lineModel.id}: ${lineModel.endTime.toFixed(2)} s`, "success");
        renderLines();
      });

      const clearEndBtn = document.createElement("button");
      clearEndBtn.type = "button";
      clearEndBtn.className = "line-end-btn";
      clearEndBtn.textContent = "Usar fin automático";
      clearEndBtn.addEventListener("click", () => {
        selectedLineId = lineModel.id;
        lineModel.endTime = null;
        setStatus(`La línea ${lineModel.id} usará fin automático.`, "success");
        renderLines();
      });

      lineEndRow.appendChild(endLabel);
      lineEndRow.appendChild(endBtn);
      lineEndRow.appendChild(clearEndBtn);
      card.appendChild(lineEndRow);
    }

    linesContainer.appendChild(card);
  });

  const timedLines = lineModels.filter((line) => line.startTime != null).length;
  summaryEl.textContent = `${lineModels.length} línea(s), ${timedLines} con tiempo asignado, ${questionWordIds.size} palabra(s) marcada(s) como pregunta.`;
  syncToolbarState();
}

function updateLineSelectionUi() {
  const rows = linesContainer.querySelectorAll("[data-line-id]");
  rows.forEach((row) => {
    const rowLineId = Number(row.dataset.lineId);
    row.classList.toggle("selected", rowLineId === selectedLineId);
    row.classList.toggle("playing", rowLineId === currentPlaybackLineId);
  });
}

async function saveSong() {
  try {
    validateSong();
    const payload = buildSongPayload();

    const response = await fetch("/api/admin/songs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "No se pudo guardar");
    }

    setStatus(`Canción guardada correctamente. Archivo: ${data.files.lyrics}`, "success");
  } catch (error) {
    console.error("Error saving song", error);
    setStatus(error.message || "No se pudo guardar la canción", "error");
  }
}

function validateSong() {
  const youtubeId = extractYoutubeId(youtubeIdInput.value.trim());

  if (!songTitleInput.value.trim() || !songArtistInput.value.trim() || !youtubeId) {
    throw new Error("Completa título, artista y un link o ID válido de YouTube.");
  }

  youtubeIdInput.value = youtubeId;

  if (lineModels.length === 0) {
    throw new Error("Prepara las líneas primero.");
  }

  if (lineModels.some((line) => line.startTime == null)) {
    throw new Error("Todas las líneas deben tener tiempo asignado.");
  }

  const orderedTimes = lineModels.map((line) => line.startTime);
  for (let index = 1; index < orderedTimes.length; index += 1) {
    if (orderedTimes[index] <= orderedTimes[index - 1]) {
      throw new Error("Los tiempos deben ir en orden ascendente.");
    }
  }

  if (timingMode === "line") {
    lineModels.forEach((lineModel, index) => {
      if (lineModel.endTime != null && lineModel.endTime <= lineModel.startTime) {
        throw new Error(`El fin manual de la línea ${lineModel.id} debe ser mayor al inicio.`);
      }

      const nextLine = lineModels[index + 1];
      if (lineModel.endTime != null && nextLine && lineModel.endTime > nextLine.startTime) {
        throw new Error(`El fin manual de la línea ${lineModel.id} no puede pasar del inicio de la siguiente línea.`);
      }
    });
  }

  lineModels.forEach((lineModel) => {
    const manualTimes = lineModel.wordTimes.filter((time) => typeof time === "number");
    for (let index = 1; index < manualTimes.length; index += 1) {
      if (manualTimes[index] <= manualTimes[index - 1]) {
        throw new Error(`Los tiempos manuales de la línea ${lineModel.id} deben ir en orden ascendente.`);
      }
    }
  });
}

function buildSongPayload() {
  const words = [];
  const lines = [];
  let wordIdCounter = 1;

  lineModels.forEach((lineModel, lineIndex) => {
    const wordIds = [];
    const nextLine = lineModels[lineIndex + 1];
    const endTime = timingMode === "line"
      ? resolveLineEndTime(lineModel, nextLine)
      : nextLine
        ? nextLine.startTime
        : lineModel.startTime + Math.max(2, lineModel.tokens.length * 0.55);
    const resolvedTimes = resolveWordTimes(lineModel, endTime);

    lineModel.tokens.forEach((token, tokenIndex) => {
      const id = wordIdCounter;
      words.push({
        id,
        text: token,
        time: Number(resolvedTimes[tokenIndex].toFixed(2)),
      });

      wordIds.push(id);
      wordIdCounter += 1;
    });

    lines.push({
      id: lineModel.id,
      wordIds,
    });
  });

  return {
    song: {
      id: songIdInput.value.trim() || slugify(`${songArtistInput.value} ${songTitleInput.value}`),
      title: songTitleInput.value.trim(),
      artist: songArtistInput.value.trim(),
      youtubeId: extractYoutubeId(youtubeIdInput.value.trim()),
    },
    words,
    lines,
  };
}

async function loadSong() {
  const file = loadSongInput.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (data.type !== "lyrics-base" || !data.song || !data.words || !data.lines) {
      throw new Error("Archivo JSON inválido. Debe ser un archivo de canción (lyrics-base).");
    }

    // Poblar campos
    songTitleInput.value = data.song.title;
    songArtistInput.value = data.song.artist;
    youtubeIdInput.value = data.song.youtubeId;
    songIdInput.value = data.song.id;

    // Reconstruir letra
    const lyrics = [];
    data.lines.forEach((line) => {
      const lineWords = line.wordIds.map(wordId => {
        const word = data.words.find(w => w.id === wordId);
        return word ? word.text : '';
      });
      lyrics.push(lineWords.join(' '));
    });
    lyricsInput.value = lyrics.join('\n');

    // Preparar líneas
    await buildLineModels();

    // Poblar tiempos
    data.lines.forEach((line, lineIndex) => {
      const lineModel = lineModels[lineIndex];
      if (!lineModel) return;

      // Encontrar startTime: el menor time de las words
      const wordTimes = line.wordIds.map(wordId => {
        const word = data.words.find(w => w.id === wordId);
        return word ? word.time : null;
      }).filter(t => t != null);
      lineModel.startTime = Math.min(...wordTimes);

      // endTime: si hay siguiente línea, su startTime, sino auto
      const nextLine = data.lines[lineIndex + 1];
      if (nextLine) {
        const nextWordTimes = nextLine.wordIds.map(wordId => {
          const word = data.words.find(w => w.id === wordId);
          return word ? word.time : null;
        }).filter(t => t != null);
        lineModel.endTime = Math.min(...nextWordTimes);
      } else {
        lineModel.endTime = null; // auto
      }

      // wordTimes
      line.wordIds.forEach((wordId, tokenIndex) => {
        const word = data.words.find(w => w.id === wordId);
        lineModel.wordTimes[tokenIndex] = word ? word.time : null;
      });
    });

    renderLines();
    setStatus("Canción cargada correctamente.", "success");
    await syncVideoFromInput();
  } catch (error) {
    console.error("Error loading song", error);
    setStatus(error.message || "No se pudo cargar la canción", "error");
  }
}


function resolveWordTimes(lineModel, endTime) {
  const totalWords = lineModel.tokens.length;
  const result = new Array(totalWords).fill(null);
  const anchors = [{ index: -1, time: lineModel.startTime }];

  lineModel.wordTimes.forEach((time, index) => {
    if (typeof time === "number") {
      anchors.push({ index, time });
    }
  });

  anchors.push({ index: totalWords, time: endTime });

  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
    const current = anchors[anchorIndex];
    const next = anchors[anchorIndex + 1];
    const startWordIndex = current.index + 1;
    const endWordIndex = next.index - 1;
    const segmentCount = next.index - current.index;

    for (let index = startWordIndex; index <= endWordIndex; index += 1) {
      const progress = (index - current.index) / segmentCount;
      result[index] = current.time + ((next.time - current.time) * progress);
    }

    if (next.index < totalWords) {
      result[next.index] = next.time;
    }
  }

  return result.map((time, index) => {
    if (typeof time === "number") return time;
    const fallbackGap = Math.max(0.12, (endTime - lineModel.startTime) / Math.max(1, totalWords));
    return lineModel.startTime + (fallbackGap * index);
  });
}

function resolveLineEndTime(lineModel, nextLine) {
  if (typeof lineModel.endTime === "number") {
    return lineModel.endTime;
  }

  if (nextLine?.startTime != null) {
    return nextLine.startTime;
  }

  return lineModel.startTime + Math.max(2, lineModel.tokens.length * 0.55);
}

function selectAllQuestionWords() {
  lineModels.forEach((lineModel) => {
    lineModel.tokens.forEach((_, tokenIndex) => {
      questionWordIds.add(buildTempWordKey(lineModel.id, tokenIndex));
    });
  });
  renderLines();
}

function clearQuestionWords() {
  questionWordIds.clear();
  renderLines();
}

function buildTempWordKey(lineId, tokenIndex) {
  return `${lineId}:${tokenIndex}`;
}

function setStatus(message, tone = "") {
  statusEl.textContent = message;
  statusEl.className = tone;
}

async function syncVideoFromInput() {
  const youtubeId = extractYoutubeId(youtubeIdInput.value.trim());

  if (!youtubeId) {
    return;
  }

  youtubeIdInput.value = youtubeId;
  await ensurePlayerReady();

  try {
    if (player?.cueVideoById) {
      player.cueVideoById({ videoId: youtubeId });
      setStatus("Video preparado. Ya puedes tomar tiempos.", "success");
      return;
    }

    player.loadVideoById(youtubeId);
    setStatus("Video cargado. Ya puedes tomar tiempos.", "success");
  } catch (error) {
    console.error("Error loading video in editor", error);
    setStatus("No pude cargar ese video de YouTube. Revisa el link o ID.", "error");
  }
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractYoutubeId(value) {
  const input = String(value || "").trim();
  if (!input) return "";

  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  try {
    const url = new URL(input);

    if (url.hostname.includes("youtu.be")) {
      const candidate = url.pathname.split("/").filter(Boolean)[0] || "";
      return /^[a-zA-Z0-9_-]{11}$/.test(candidate) ? candidate : "";
    }

    const watchId = url.searchParams.get("v") || "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(watchId)) {
      return watchId;
    }

    const pathCandidate = url.pathname.split("/").filter(Boolean).pop() || "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(pathCandidate)) {
      return pathCandidate;
    }
  } catch {
    return "";
  }

  return "";
}

function setClickMode(nextMode) {
  clickMode = nextMode;
  syncToolbarState();
  renderLines();
}

function setTimingMode(nextMode) {
  timingMode = nextMode;
  syncToolbarState();
  renderLines();
}

function syncToolbarState() {
  modeQuestionBtn.classList.toggle("active", clickMode === "question");
  modeTimingBtn.classList.toggle("active", clickMode === "timing");
  timingWordBtn.classList.toggle("active", timingMode === "word");
  timingLineBtn.classList.toggle("active", timingMode === "line");
  followBtn.classList.toggle("active", followPlayback);
}

function getSelectedLine() {
  return lineModels.find((lineModel) => lineModel.id === selectedLineId) || null;
}

function syncSelectedLineStart() {
  const lineModel = getSelectedLine();
  if (!lineModel || !player?.getCurrentTime) {
    setStatus("Selecciona una línea y asegúrate de que el video esté listo.", "error");
    return;
  }
  setLineStartTime(lineModel, Number(player.getCurrentTime().toFixed(2)));
  setStatus(`Inicio de la línea ${lineModel.id}: ${lineModel.startTime.toFixed(2)} s`, "success");
  renderLines();
}

function markSelectedLineEnd() {
  const lineModel = getSelectedLine();
  if (!lineModel || !player?.getCurrentTime) {
    setStatus("Selecciona una línea y asegúrate de que el video esté listo.", "error");
    return;
  }
  lineModel.endTime = Number(player.getCurrentTime().toFixed(2));
  setStatus(`Fin de la línea ${lineModel.id}: ${lineModel.endTime.toFixed(2)} s`, "success");
  renderLines();
}

function replaySelectedLine() {
  const lineModel = getSelectedLine();
  if (!lineModel || !player?.seekTo || !player?.playVideo) {
    setStatus("Selecciona una línea y asegúrate de que el video esté listo.", "error");
    return;
  }

  player.seekTo(Math.max(0, (lineModel.startTime ?? 0) - 0.25), true);
  player.playVideo();
}

function toggleFollowPlayback() {
  followPlayback = !followPlayback;
  syncToolbarState();
  if (followPlayback && currentPlaybackLineId != null) {
    const target = linesContainer.querySelector(`[data-line-id="${currentPlaybackLineId}"]`);
    if (target) {
      ensureLineVisible(target);
    }
  }
}

function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => {
      resolve(window.YT);
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("No se pudo cargar la API de YouTube."));
    document.head.appendChild(script);

    setTimeout(() => {
      if (!window.YT?.Player) {
        reject(new Error("La API de YouTube tardó demasiado en responder."));
      }
    }, 10000);
  });

  return youtubeApiPromise;
}

function createPlayer() {
  return new Promise((resolve, reject) => {
    try {
      const instance = new window.YT.Player("player", {
        width: "640",
        height: "360",
        videoId: "",
        playerVars: {
          controls: 1,
          enablejsapi: 1,
          origin: window.location.origin,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            setInterval(updatePlaybackCursor, 200);
            resolve(instance);
          },
          onError: () => reject(new Error("No pude crear el reproductor de YouTube.")),
        },
      });
    } catch (error) {
      reject(error);
    }
  });
}

function updatePlaybackCursor() {
  if (!player?.getCurrentTime || lineModels.length === 0) return;

  const currentTime = player.getCurrentTime();
  const activeLine = getLineByTime(currentTime);
  const nextPlaybackLineId = activeLine?.id ?? null;

  if (nextPlaybackLineId === currentPlaybackLineId) return;

  currentPlaybackLineId = nextPlaybackLineId;

  updateLineSelectionUi();

  if (followPlayback && currentPlaybackLineId != null && isPlayerPlaying()) {
    const target = linesContainer.querySelector(`[data-line-id="${currentPlaybackLineId}"]`);
    if (target) {
      ensureLineVisible(target);
    }
  }
}

function getLineByTime(currentTime) {
  for (let index = 0; index < lineModels.length; index += 1) {
    const lineModel = lineModels[index];
    if (lineModel.startTime == null) {
      continue;
    }
    const nextLine = lineModels[index + 1];
    const start = lineModel.startTime ?? 0;
    const end = resolveEditorLineEndTime(lineModel, nextLine);
    if (currentTime >= start && currentTime < end) {
      return lineModel;
    }
  }
  return null;
}

function setLineStartTime(lineModel, nextStartTime) {
  lineModel.startTime = nextStartTime;

  if (typeof lineModel.endTime === "number" && lineModel.endTime <= nextStartTime) {
    lineModel.endTime = null;
  }
}

function resolveEditorLineEndTime(lineModel, nextLine) {
  if (typeof lineModel.endTime === "number") {
    return lineModel.endTime;
  }

  if (nextLine?.startTime != null) {
    return nextLine.startTime;
  }

  return Number.POSITIVE_INFINITY;
}

function isPlayerPlaying() {
  if (!player?.getPlayerState || !window.YT?.PlayerState) {
    return false;
  }

  return player.getPlayerState() === window.YT.PlayerState.PLAYING;
}

function ensureLineVisible(target) {
  if (!lyricsScrollEl || !target) {
    return;
  }

  const containerRect = lyricsScrollEl.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const topPadding = 24;
  const bottomPadding = 40;

  if (targetRect.top < containerRect.top + topPadding) {
    lyricsScrollEl.scrollTop -= (containerRect.top + topPadding) - targetRect.top;
    return;
  }

  if (targetRect.bottom > containerRect.bottom - bottomPadding) {
    lyricsScrollEl.scrollTop += targetRect.bottom - (containerRect.bottom - bottomPadding);
  }
}
