// Core state engine for Anagrammatica.
// Depends on WORDS / isValidWord from words.js (loaded first in index.html).

const ROUND_SECONDS = 30;
const TILE_COUNT = 9;

// Authentic tile-bag distribution (mirrors real English letter frequency,
// modeled on the classic Countdown letters set). Counts are the total
// number of physical tiles of that letter in the bag for one round.
const VOWEL_POOL = {
  A: 15, E: 21, I: 13, O: 13, U: 5,
};

const CONSONANT_POOL = {
  B: 2, C: 3, D: 6, F: 2, G: 3, H: 2, J: 1, K: 1, L: 5, M: 4,
  N: 8, P: 4, Q: 1, R: 9, S: 9, T: 9, V: 1, W: 1, X: 1, Y: 1, Z: 1,
};

// Escalating length bonus: base = word length, with extra bonus for
// longer words (rewards using more of the 9 tiles).
const LENGTH_SCORES = {
  3: 3, 4: 4, 5: 6, 6: 9, 7: 13, 8: 18, 9: 25,
};

function scoreForWord(word) {
  return LENGTH_SCORES[word.length] || 0;
}

function buildBag(pool) {
  const bag = [];
  for (const [letter, count] of Object.entries(pool)) {
    for (let i = 0; i < count; i++) bag.push(letter);
  }
  return bag;
}

function drawFrom(bag) {
  if (bag.length === 0) return null;
  const index = Math.floor(Math.random() * bag.length);
  return bag.splice(index, 1)[0];
}

const GameState = {
  vowelBag: [],
  consonantBag: [],
  tiles: [],
  timeRemaining: ROUND_SECONDS,
  timerId: null,
  roundActive: false,
  score: 0,
  foundWords: [],

  listeners: {
    onTilesChanged: null,
    onTimerTick: null,
    onRoundEnd: null,
    onWordAccepted: null,
    onWordRejected: null,
    onBoardFull: null,
  },

  newRound() {
    this.vowelBag = buildBag(VOWEL_POOL);
    this.consonantBag = buildBag(CONSONANT_POOL);
    this.tiles = [];
    this.timeRemaining = ROUND_SECONDS;
    this.roundActive = false;
    this.score = 0;
    this.foundWords = [];
    this.stopTimer();
    this._emit("onTilesChanged", this.tiles);
  },

  canPick() {
    return this.tiles.length < TILE_COUNT;
  },

  pickVowel() {
    if (!this.canPick()) return null;
    const letter = drawFrom(this.vowelBag);
    if (!letter) return null;
    this._addTile(letter);
    return letter;
  },

  pickConsonant() {
    if (!this.canPick()) return null;
    const letter = drawFrom(this.consonantBag);
    if (!letter) return null;
    this._addTile(letter);
    return letter;
  },

  _addTile(letter) {
    this.tiles.push(letter);
    this._emit("onTilesChanged", this.tiles);
    if (this.tiles.length === TILE_COUNT) {
      this._emit("onBoardFull", this.tiles);
      this.startRound();
    }
  },

  startRound() {
    if (this.roundActive) return;
    this.roundActive = true;
    this.timeRemaining = ROUND_SECONDS;
    this._emit("onTimerTick", this.timeRemaining);
    this.timerId = setInterval(() => {
      this.timeRemaining -= 1;
      this._emit("onTimerTick", this.timeRemaining);
      if (this.timeRemaining <= 0) {
        this.endRound();
      }
    }, 1000);
  },

  endRound() {
    this.stopTimer();
    this.roundActive = false;
    this._emit("onRoundEnd", { score: this.score, words: this.foundWords });
  },

  stopTimer() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  },

  submitWord(rawWord) {
    const word = (rawWord || "").trim().toLowerCase();

    if (!this.roundActive) {
      this._emit("onWordRejected", { word, reason: "round-not-active" });
      return { ok: false, reason: "round-not-active" };
    }

    if (word.length < 3) {
      this._emit("onWordRejected", { word, reason: "too-short" });
      return { ok: false, reason: "too-short" };
    }

    if (this.foundWords.includes(word)) {
      this._emit("onWordRejected", { word, reason: "duplicate" });
      return { ok: false, reason: "duplicate" };
    }

    if (!this._canFormFromTiles(word)) {
      this._emit("onWordRejected", { word, reason: "not-in-tiles" });
      return { ok: false, reason: "not-in-tiles" };
    }

    if (!isValidWord(word)) {
      this._emit("onWordRejected", { word, reason: "not-a-word" });
      return { ok: false, reason: "not-a-word" };
    }

    const points = scoreForWord(word);
    this.score += points;
    this.foundWords.push(word);
    this._emit("onWordAccepted", { word, points, total: this.score });
    return { ok: true, points, total: this.score };
  },

  _canFormFromTiles(word) {
    const available = this.tiles.map((t) => t.toLowerCase()).slice();
    for (const ch of word) {
      const idx = available.indexOf(ch);
      if (idx === -1) return false;
      available.splice(idx, 1);
    }
    return true;
  },

  on(event, handler) {
    this.listeners[event] = handler;
  },

  _emit(event, payload) {
    const handler = this.listeners[event];
    if (typeof handler === "function") handler(payload);
  },
};

// ---- UI wiring ----

document.addEventListener("DOMContentLoaded", () => {
  const tileEls = Array.from(document.querySelectorAll("[data-tile-slot]"));
  const vowelBtn = document.getElementById("pick-vowel");
  const consonantBtn = document.getElementById("pick-consonant");
  const timerEl = document.getElementById("timer");
  const scoreEl = document.getElementById("score");
  const wordInput = document.getElementById("word-input");
  const submitBtn = document.getElementById("submit-word");
  const foundListEl = document.getElementById("found-words");
  const feedbackEl = document.getElementById("feedback");
  const newRoundBtn = document.getElementById("new-round");
  const resultsPanel = document.getElementById("results-panel");
  const finalScoreEl = document.getElementById("final-score");
  const finalWordsEl = document.getElementById("final-words");

  function renderTiles() {
    tileEls.forEach((el, i) => {
      const letter = GameState.tiles[i];
      el.textContent = letter || "";
      el.classList.toggle("tile-filled", Boolean(letter));
    });
    const remaining = TILE_COUNT - GameState.tiles.length;
    if (vowelBtn) vowelBtn.disabled = remaining === 0 || GameState.vowelBag.length === 0;
    if (consonantBtn) consonantBtn.disabled = remaining === 0 || GameState.consonantBag.length === 0;
  }

  function renderTimer(t) {
    if (!timerEl) return;
    timerEl.textContent = String(Math.max(t, 0)).padStart(2, "0");
    timerEl.classList.toggle("timer-warning", t <= 10 && t > 0);
  }

  function renderScore() {
    if (scoreEl) scoreEl.textContent = String(GameState.score);
  }

  function renderFeedback(message, type) {
    if (!feedbackEl) return;
    feedbackEl.textContent = message;
    feedbackEl.className = "feedback-" + type;
  }

  function renderFoundWords() {
    if (!foundListEl) return;
    foundListEl.innerHTML = "";
    GameState.foundWords.forEach((w) => {
      const li = document.createElement("li");
      li.textContent = `${w.toUpperCase()} (+${scoreForWord(w)})`;
      foundListEl.appendChild(li);
    });
  }

  GameState.on("onTilesChanged", renderTiles);

  GameState.on("onBoardFull", () => {
    if (wordInput) {
      wordInput.disabled = false;
      wordInput.focus();
    }
    if (submitBtn) submitBtn.disabled = false;
  });

  GameState.on("onTimerTick", renderTimer);

  GameState.on("onWordAccepted", ({ word, points }) => {
    renderScore();
    renderFoundWords();
    renderFeedback(`"${word.toUpperCase()}" accepted +${points}`, "good");
    if (wordInput) wordInput.value = "";
  });

  GameState.on("onWordRejected", ({ word, reason }) => {
    const messages = {
      "too-short": "Words must be at least 3 letters.",
      duplicate: "Already found that word.",
      "not-in-tiles": "That word isn't in your tiles.",
      "not-a-word": "Not in the dictionary.",
      "round-not-active": "Pick all 9 tiles to start the round.",
    };
    renderFeedback(messages[reason] || "Invalid word.", "bad");
  });

  GameState.on("onRoundEnd", ({ score, words }) => {
    if (wordInput) wordInput.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    if (vowelBtn) vowelBtn.disabled = true;
    if (consonantBtn) consonantBtn.disabled = true;
    if (resultsPanel) resultsPanel.classList.remove("hidden");
    if (finalScoreEl) finalScoreEl.textContent = String(score);
    if (finalWordsEl) {
      finalWordsEl.innerHTML = "";
      words.forEach((w) => {
        const li = document.createElement("li");
        li.textContent = `${w.toUpperCase()} (+${scoreForWord(w)})`;
        finalWordsEl.appendChild(li);
      });
    }
  });

  function handlePick(kind) {
    const letter = kind === "vowel" ? GameState.pickVowel() : GameState.pickConsonant();
    if (!letter) renderFeedback("No more of that type left in the bag.", "bad");
  }

  if (vowelBtn) vowelBtn.addEventListener("click", () => handlePick("vowel"));
  if (consonantBtn) consonantBtn.addEventListener("click", () => handlePick("consonant"));

  function handleSubmit() {
    if (!wordInput) return;
    GameState.submitWord(wordInput.value);
    wordInput.focus();
  }

  if (submitBtn) submitBtn.addEventListener("click", handleSubmit);
  if (wordInput) {
    wordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    });
  }

  function startNewRound() {
    GameState.newRound();
    renderTiles();
    renderTimer(ROUND_SECONDS);
    renderScore();
    renderFoundWords();
    renderFeedback("Pick 9 letters to begin.", "info");
    if (wordInput) {
      wordInput.value = "";
      wordInput.disabled = true;
    }
    if (submitBtn) submitBtn.disabled = true;
    if (resultsPanel) resultsPanel.classList.add("hidden");
  }

  if (newRoundBtn) newRoundBtn.addEventListener("click", startNewRound);

  startNewRound();
});
