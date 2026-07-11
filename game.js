// Core state engine for Anagrammatica.
// Depends on WORDS / isValidWord from words.js (loaded first in index.html).

const ROUND_SECONDS = 30;
const TILE_COUNT = 9;

// ---- Audio engine ----
// Synthesizes all sound effects with the Web Audio API — no audio files.
// A single AudioContext is created lazily on first user gesture (required
// by browser autoplay policy) and reused for every subsequent sound.

const AudioEngine = (() => {
  let ctx = null;
  let muted = localStorage.getItem("anagrammatica-muted") === "true";

  function getContext() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctx();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // A single oscillator voice with an ADSR-ish gain envelope.
  function playTone({ freq, start = 0, duration = 0.12, type = "sine", peak = 0.25, endFreq = null }) {
    if (muted) return;
    const audioCtx = getContext();
    const t0 = audioCtx.currentTime + start;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t0 + duration);
    }

    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  return {
    // High-pitched mechanical blip when a letter lands on a tile.
    tileFlip() {
      playTone({ freq: 1400, duration: 0.06, type: "square", peak: 0.12, endFreq: 900 });
    },

    // Low woodblock-style tick, played once per second during the round.
    // `urgent` (final 5 seconds) uses a higher pitch and slightly sharper decay.
    tick(urgent) {
      playTone({
        freq: urgent ? 520 : 340,
        duration: urgent ? 0.05 : 0.07,
        type: "square",
        peak: urgent ? 0.22 : 0.15,
        endFreq: urgent ? 300 : 200,
      });
    },

    // Ascending arcade-style chime for an accepted word.
    successChime() {
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      notes.forEach((freq, i) => {
        playTone({ freq, start: i * 0.07, duration: 0.18, type: "triangle", peak: 0.2 });
      });
    },

    // Low, discordant buzzer for an invalid word or round timeout.
    buzzer() {
      playTone({ freq: 110, duration: 0.35, type: "sawtooth", peak: 0.2, endFreq: 70 });
      playTone({ freq: 116, duration: 0.35, type: "sawtooth", peak: 0.15, endFreq: 74 });
    },

    isMuted() {
      return muted;
    },

    setMuted(value) {
      muted = value;
      localStorage.setItem("anagrammatica-muted", String(muted));
    },

    toggleMuted() {
      this.setMuted(!muted);
      return muted;
    },
  };
})();

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

// Can `word` be spelled using only the letters in `tiles` (respecting
// each letter's available count)? Shared by submission validation and
// the best-possible-word search.
function canFormFromTiles(word, tiles) {
  const available = tiles.map((t) => t.toLowerCase()).slice();
  for (const ch of word) {
    const idx = available.indexOf(ch);
    if (idx === -1) return false;
    available.splice(idx, 1);
  }
  return true;
}

// Finds the longest dictionary word formable from this tile pool —
// the "optimal anagram" shown in the round review. Ties are broken by
// first match in WORDS. O(dictionary size), fine for a few thousand words.
function findLongestWord(tiles) {
  let best = null;
  for (const word of WORDS) {
    if (word.length > tiles.length) continue;
    if (best && word.length <= best.length) continue;
    if (canFormFromTiles(word, tiles)) best = word;
  }
  return best;
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
  rejectedWords: [],

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
    this.rejectedWords = [];
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
    const bestWord = findLongestWord(this.tiles);
    this._emit("onRoundEnd", {
      score: this.score,
      words: this.foundWords,
      rejected: this.rejectedWords,
      bestWord,
      tiles: this.tiles.slice(),
    });
  },

  stopTimer() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  },

  submitWord(rawWord) {
    const word = (rawWord || "").trim().toLowerCase();

    const reject = (reason) => {
      this.rejectedWords.push({ word, reason });
      this._emit("onWordRejected", { word, reason });
      return { ok: false, reason };
    };

    if (!this.roundActive) return reject("round-not-active");
    if (word.length < 3) return reject("too-short");
    if (this.foundWords.includes(word)) return reject("duplicate");
    if (!canFormFromTiles(word, this.tiles)) return reject("not-in-tiles");
    if (!isValidWord(word)) return reject("not-a-word");

    const points = scoreForWord(word);
    this.score += points;
    this.foundWords.push(word);
    this._emit("onWordAccepted", { word, points, total: this.score });
    return { ok: true, points, total: this.score };
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
  const timerBarEl = document.getElementById("timer-bar");
  const scoreEl = document.getElementById("score");
  const wordInput = document.getElementById("word-input");
  const submitBtn = document.getElementById("submit-word");
  const foundListEl = document.getElementById("found-words");
  const feedbackEl = document.getElementById("feedback");
  const newRoundBtn = document.getElementById("new-round");
  const resultsPanel = document.getElementById("results-panel");
  const finalScoreEl = document.getElementById("final-score");
  const finalWordsEl = document.getElementById("final-words");
  const rejectedSectionEl = document.getElementById("rejected-words-section");
  const rejectedListEl = document.getElementById("rejected-words");
  const bestWordEl = document.getElementById("best-word");
  const muteToggleBtn = document.getElementById("mute-toggle");
  const muteIconEl = document.getElementById("mute-icon");

  const REJECTION_MESSAGES = {
    "too-short": "Too short (min. 3 letters)",
    duplicate: "Already found this word",
    "not-in-tiles": "Used letters not on the board",
    "not-a-word": "Word not in dictionary",
    "round-not-active": "Round wasn't active",
  };

  let lastTileCount = 0;

  function renderTiles() {
    tileEls.forEach((el, i) => {
      const letter = GameState.tiles[i];
      el.textContent = letter || "";
      el.classList.toggle("tile-filled", Boolean(letter));
    });
    if (GameState.tiles.length > lastTileCount) {
      AudioEngine.tileFlip();
    }
    lastTileCount = GameState.tiles.length;
    const remaining = TILE_COUNT - GameState.tiles.length;
    if (vowelBtn) vowelBtn.disabled = remaining === 0 || GameState.vowelBag.length === 0;
    if (consonantBtn) consonantBtn.disabled = remaining === 0 || GameState.consonantBag.length === 0;
  }

  let lastRenderedTime = ROUND_SECONDS;

  function renderTimer(t) {
    const clamped = Math.max(t, 0);
    if (timerEl) {
      timerEl.textContent = String(clamped).padStart(2, "0");
      timerEl.classList.toggle("timer-warning", t <= 5 && t > 0);
    }
    if (timerBarEl) {
      const pct = (clamped / ROUND_SECONDS) * 100;
      timerBarEl.style.width = pct + "%";
      timerBarEl.classList.remove("timer-bar-green", "timer-bar-amber", "timer-bar-red");
      if (t <= 5) {
        timerBarEl.classList.add("timer-bar-red");
      } else if (t <= 15) {
        timerBarEl.classList.add("timer-bar-amber");
      } else {
        timerBarEl.classList.add("timer-bar-green");
      }
    }
    // Only tick on a genuine countdown decrement — skips the initial
    // emission when the round starts and the reset call before it.
    if (t < lastRenderedTime && t >= 0) {
      AudioEngine.tick(t <= 5);
    }
    lastRenderedTime = t;
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
    AudioEngine.successChime();
    renderScore();
    renderFoundWords();
    renderFeedback(`"${word.toUpperCase()}" accepted +${points}`, "good");
    if (wordInput) wordInput.value = "";
  });

  GameState.on("onWordRejected", ({ word, reason }) => {
    AudioEngine.buzzer();
    renderFeedback(REJECTION_MESSAGES[reason] || "Invalid word.", "bad");
  });

  GameState.on("onRoundEnd", ({ score, words, rejected, bestWord }) => {
    AudioEngine.buzzer();
    if (wordInput) wordInput.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    if (vowelBtn) vowelBtn.disabled = true;
    if (consonantBtn) consonantBtn.disabled = true;
    if (resultsPanel) resultsPanel.classList.remove("hidden");
    if (finalScoreEl) finalScoreEl.textContent = String(score);

    if (finalWordsEl) {
      finalWordsEl.innerHTML = "";
      if (words.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No words found this round.";
        li.style.opacity = "0.6";
        finalWordsEl.appendChild(li);
      } else {
        words.forEach((w) => {
          const li = document.createElement("li");
          li.textContent = `${w.toUpperCase()} (+${scoreForWord(w)})`;
          finalWordsEl.appendChild(li);
        });
      }
    }

    // De-dupe rejection reasons per word so a repeatedly-mistyped word
    // doesn't spam the review with identical lines.
    const seen = new Set();
    const uniqueRejections = (rejected || []).filter(({ word, reason }) => {
      const key = word + "|" + reason;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (rejectedSectionEl && rejectedListEl) {
      rejectedListEl.innerHTML = "";
      if (uniqueRejections.length === 0) {
        rejectedSectionEl.classList.add("hidden");
      } else {
        rejectedSectionEl.classList.remove("hidden");
        uniqueRejections.forEach(({ word, reason }) => {
          const li = document.createElement("li");
          const label = word ? word.toUpperCase() : "(blank)";
          li.textContent = `${label} — ${REJECTION_MESSAGES[reason] || "Invalid"}`;
          rejectedListEl.appendChild(li);
        });
      }
    }

    if (bestWordEl) {
      bestWordEl.textContent = bestWord ? bestWord.toUpperCase() : "None found";
    }
  });

  function handlePick(kind) {
    const letter = kind === "vowel" ? GameState.pickVowel() : GameState.pickConsonant();
    if (!letter) renderFeedback("No more of that type left in the bag.", "bad");
  }

  if (vowelBtn) vowelBtn.addEventListener("click", () => handlePick("vowel"));
  if (consonantBtn) consonantBtn.addEventListener("click", () => handlePick("consonant"));

  document.addEventListener("keydown", (e) => {
    // Don't hijack V/C while the player is typing a word.
    if (document.activeElement === wordInput) return;
    if (e.key.toLowerCase() === "v" && !vowelBtn.disabled) {
      e.preventDefault();
      handlePick("vowel");
    } else if (e.key.toLowerCase() === "c" && !consonantBtn.disabled) {
      e.preventDefault();
      handlePick("consonant");
    }
  });

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
    if (timerEl) timerEl.classList.remove("timer-warning");
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

  function renderMuteState() {
    const muted = AudioEngine.isMuted();
    if (muteToggleBtn) {
      muteToggleBtn.setAttribute("aria-pressed", String(muted));
      muteToggleBtn.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
    }
    if (muteIconEl) muteIconEl.textContent = muted ? "🔇" : "🔊";
  }

  if (muteToggleBtn) {
    muteToggleBtn.addEventListener("click", () => {
      AudioEngine.toggleMuted();
      renderMuteState();
    });
  }
  renderMuteState();

  startNewRound();
});
