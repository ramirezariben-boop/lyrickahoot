const WS_URL =
  location.hostname === "localhost"
    ? "ws://localhost:3000"
    : "wss://lyrickahoot.onrender.com";

const PLAYER_PROFILE_KEY = "PLAYER_PROFILE";
const PLAYER_AUTH_TOKEN_KEY = "PLAYER_AUTH_TOKEN";
const TOTAL_POINTS_KEY = "totalPoints";
const ANSWERED_QUESTION_KEY = "answeredQuestionKey";
const CURRENT_QUESTION_KEY = "currentQuestion";

const overlay = document.getElementById("overlay");
const roomCodeInput = document.getElementById("roomCodeInput");
const roomBtn = document.getElementById("roomBtn");
const roomError = document.getElementById("roomError");
const stepRoom = document.getElementById("stepRoom");
const stepProfile = document.getElementById("stepProfile");
const studentIdInput = document.getElementById("studentIdInput");
const nipInput = document.getElementById("nipInput");
const nicknameInput = document.getElementById("nicknameInput");
const loginBtn = document.getElementById("loginBtn");
const loginError = document.getElementById("loginError");
const pointsValue = document.getElementById("pointsValue");
const titleEl = document.getElementById("title");
const optionsEl = document.getElementById("options");

let selectedEmoji = null;
let roomCode = "";
let authToken = sessionStorage.getItem(PLAYER_AUTH_TOKEN_KEY) || "";
let playerProfile = safeJsonParse(sessionStorage.getItem(PLAYER_PROFILE_KEY));
let channel = null;
let userId = "";
let userNickname = "";
let playerState = "WAITING";
let currentQuestion = null;
let totalPoints = Number(sessionStorage.getItem(TOTAL_POINTS_KEY) || 0);
let reconnectTimeout = null;

pointsValue.textContent = totalPoints;

bindUi();
resumeSavedSession();

function bindUi() {
  roomBtn.addEventListener("click", verifyRoom);
  loginBtn.addEventListener("click", loginPlayer);

  document.querySelectorAll(".emoji").forEach((node) => {
    node.addEventListener("click", () => {
      selectedEmoji = node.textContent;
      renderSelectedEmoji();
    });
  });
}

function renderSelectedEmoji() {
  document.querySelectorAll(".emoji").forEach((node) => {
    node.classList.toggle("selected", node.textContent === selectedEmoji);
  });
}

async function verifyRoom() {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) {
    roomError.textContent = "Ingresa un código";
    return;
  }

  roomError.textContent = "Verificando sala...";
  const ok = await checkRoomCode(code);
  if (!ok) {
    roomError.textContent = "Código inválido o sala cerrada";
    return;
  }

  roomCode = code;
  roomError.textContent = "";
  stepRoom.style.display = "none";
  stepProfile.style.display = "block";
}

function checkRoomCode(code) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const done = (value) => {
      try {
        ws.close();
      } catch {
        // noop
      }
      resolve(value);
    };

    const timer = setTimeout(() => done(false), 1500);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "ROOM_CHECK", roomCode: code }));
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "ROOM_OK") {
        clearTimeout(timer);
        done(true);
      }

      if (msg.type === "ROOM_NO") {
        clearTimeout(timer);
        done(false);
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      done(false);
    };
  });
}

async function loginPlayer() {
  const studentId = studentIdInput.value.trim();
  const nip = nipInput.value.trim();
  const nickname = nicknameInput.value.trim();

  if (!studentId || !nip || !nickname) {
    loginError.textContent = "Completa todos los campos";
    return;
  }

  if (nip.length !== 4) {
    loginError.textContent = "NIP inválido";
    return;
  }

  if (!/^[\w\s]{1,16}$/u.test(nickname)) {
    loginError.textContent = "Nickname inválido";
    return;
  }

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: studentId, nip, role: "player" }),
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      loginError.textContent = "ID o NIP incorrectos";
      return;
    }

    authToken = data.authToken;
    userId = String(data.user.id);
    userNickname = nickname;
    selectedEmoji = selectedEmoji || "🙂";
    playerProfile = {
      roomCode,
      studentId: userId,
      nickname: userNickname,
      emoji: selectedEmoji,
    };

    sessionStorage.setItem(PLAYER_AUTH_TOKEN_KEY, authToken);
    sessionStorage.setItem(PLAYER_PROFILE_KEY, JSON.stringify(playerProfile));
    renderSelectedEmoji();
    connectPlayer(false);
    overlay.style.display = "none";
  } catch (error) {
    console.error("Player login failed", error);
    loginError.textContent = "No pude validar tu cuenta";
  }
}

function connectPlayer(isReconnect) {
  try {
    channel?.close();
  } catch {
    // noop
  }

  channel = new WebSocket(WS_URL);

  channel.onopen = () => {
    clearTimeout(reconnectTimeout);
    channel.send(JSON.stringify({
      type: "HELLO",
      role: "PLAYER",
      roomCode,
      authToken,
      nickname: playerProfile.nickname,
      emoji: playerProfile.emoji,
    }));

    sendPlayerHeartbeat(isReconnect ? "PLAYER_REJOIN" : "PLAYER_JOIN");
  };

  channel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  channel.onclose = () => {
    if (!playerProfile || !authToken) return;
    titleEl.textContent = "Reconectando...";
    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => connectPlayer(true), 2000);
  };
}

function handleMessage(msg) {
  if (msg.type === "AUTH_ERROR") {
    resetLocalSession();
    location.reload();
    return;
  }

  if (msg.type === "PLAYER_OK") {
    userId = String(msg.userId || playerProfile.studentId);
    return;
  }

  if (msg.type === "OPEN") {
    const questionKey = buildQuestionKey(msg.wordId, msg.openedAt);
    if (sessionStorage.getItem(ANSWERED_QUESTION_KEY) === questionKey) {
      return;
    }
    openQuestion(msg.wordId, msg.openedAt, msg.options || []);
    return;
  }

  if (msg.type === "CLOSE") {
    showWaiting();
    return;
  }

  if (msg.type === "QUESTION_RESULT") {
    const earned = Number(msg.scores?.[userId] || 0);
    totalPoints += earned;
    sessionStorage.setItem(TOTAL_POINTS_KEY, String(totalPoints));
    pointsValue.textContent = totalPoints;
    return;
  }

  if (msg.type === "GAME_RESET") {
    resetLocalSession();
    location.reload();
  }
}

function openQuestion(wordId, openedAt, options) {
  playerState = "ANSWERING";
  currentQuestion = {
    wordId: Number(wordId),
    openedAt: Number(openedAt),
    options: options.map(String),
  };

  titleEl.textContent = "¿Qué palabra escuchaste?";
  sessionStorage.setItem(CURRENT_QUESTION_KEY, JSON.stringify(currentQuestion));
  renderOptions();
}

function renderOptions() {
  optionsEl.innerHTML = "";

  currentQuestion.options.forEach((option) => {
    const button = document.createElement("button");
    button.className = "option";
    button.textContent = option;
    button.addEventListener("click", () => submitAnswer(option, button));
    optionsEl.appendChild(button);
  });
}

function submitAnswer(answer, button) {
  if (playerState !== "ANSWERING" || !currentQuestion) return;

  playerState = "ANSWERED";
  button.classList.add("selected");

  document.querySelectorAll(".option").forEach((node) => {
    node.classList.add("disabled");
    node.disabled = true;
  });

  channel.send(JSON.stringify({
    type: "ANSWER",
    wordId: currentQuestion.wordId,
    answer,
    timestamp: Date.now(),
  }));

  sessionStorage.setItem(ANSWERED_QUESTION_KEY, buildQuestionKey(currentQuestion.wordId, currentQuestion.openedAt));
  titleEl.textContent = "Respuesta enviada";
}

function showWaiting() {
  playerState = "WAITING";
  currentQuestion = null;
  sessionStorage.removeItem(CURRENT_QUESTION_KEY);
  titleEl.textContent = "Esperando siguiente pregunta...";
  optionsEl.innerHTML = "";
}

function sendPlayerHeartbeat(type = "PLAYER_ALIVE") {
  if (!channel || channel.readyState !== WebSocket.OPEN || !playerProfile) return;
  channel.send(JSON.stringify({
    type: "PLAYER_TO_HOST",
    payload: {
      type,
    },
  }));
}

setInterval(() => {
  sendPlayerHeartbeat();
}, 5000);

function resumeSavedSession() {
  if (!playerProfile || !authToken) return;

  roomCode = playerProfile.roomCode;
  userId = playerProfile.studentId;
  userNickname = playerProfile.nickname;
  selectedEmoji = playerProfile.emoji || "🙂";
  renderSelectedEmoji();
  overlay.style.display = "none";
  connectPlayer(true);
}

function resetLocalSession() {
  playerProfile = null;
  authToken = "";
  currentQuestion = null;
  clearTimeout(reconnectTimeout);
  sessionStorage.removeItem(PLAYER_PROFILE_KEY);
  sessionStorage.removeItem(PLAYER_AUTH_TOKEN_KEY);
  sessionStorage.removeItem(TOTAL_POINTS_KEY);
  sessionStorage.removeItem(ANSWERED_QUESTION_KEY);
  sessionStorage.removeItem(CURRENT_QUESTION_KEY);
}

function buildQuestionKey(wordId, openedAt) {
  return `${wordId}:${openedAt}`;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
