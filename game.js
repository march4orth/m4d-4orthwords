// Core state engine for 4orthwords.
// Depends on WORDS / isValidWord from words.js (loaded first in index.html).

const ROUND_SECONDS = 30;
const TILE_COUNT = 9;

// ---- Audio engine ----
// Synthesizes all sound effects with the Web Audio API — no audio files.
// A single AudioContext is created lazily on first user gesture (required
// by browser autoplay policy) and reused for every subsequent sound.

const AudioEngine = (() => {
  let ctx = null;
  let muted = localStorage.getItem("4orthwords-muted") === "true";

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
      localStorage.setItem("4orthwords-muted", String(muted));
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

// Draws from the front of an already-shuffled bag (splice(0,1) — not a
// random index) so that, for a seeded/pre-shuffled daily bag, the Nth
// pick of a given type is deterministic: every player who clicks the
// same Vowel/Consonant sequence gets the same letters in the same order.
function drawFrom(bag) {
  if (bag.length === 0) return null;
  return bag.splice(0, 1)[0];
}

// mulberry32 — small, fast, seedable PRNG. Deterministic: the same
// 32-bit seed always produces the same output sequence, which is what
// makes the Daily Challenge reproducible across every player's browser.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derives a 32-bit integer seed from a date string like "2026-07-11" —
// stable across sessions/devices as long as the calendar date matches.
function seedFromDateString(dateStr) {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = (Math.imul(31, hash) + dateStr.charCodeAt(i)) | 0;
  }
  return hash;
}

function todayDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Fisher-Yates shuffle driven by an injectable RNG — `rng` defaults to
// Math.random for normal play, or a seeded mulberry32() for the daily bag.
function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Stats + Daily Challenge persistence ----
// All state lives in a single localStorage record so a corrupted/missing
// key degrades to sensible defaults rather than throwing.

const STATS_KEY = "4orthwords-stats";

function defaultStats() {
  return {
    gamesPlayed: 0,
    bestWord: null, // { word, points }
    streak: 0,
    lastDailyDate: null, // last calendar date the daily challenge was completed
    lastDailyResult: null, // { score, words, tiles, timeLeft } for the locked replay view
  };
}

const Stats = (() => {
  let data = load();

  function load() {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      if (!raw) return defaultStats();
      const parsed = JSON.parse(raw);
      return { ...defaultStats(), ...parsed };
    } catch (e) {
      return defaultStats();
    }
  }

  function save() {
    localStorage.setItem(STATS_KEY, JSON.stringify(data));
  }

  // Yesterday's date string, for streak continuity checks.
  function yesterdayDateString() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return {
    get() {
      return data;
    },

    hasPlayedDailyToday() {
      return data.lastDailyDate === todayDateString();
    },

    getDailyResult() {
      return data.lastDailyResult;
    },

    // Called once per completed round (either mode). `isDaily` triggers
    // the daily-specific bookkeeping (lock + streak).
    recordRoundResult({ score, words, tiles, timeLeft, isDaily }) {
      data.gamesPlayed += 1;

      words.forEach((word) => {
        const points = scoreForWord(word);
        if (!data.bestWord || points > data.bestWord.points) {
          data.bestWord = { word, points };
        }
      });

      if (isDaily) {
        const today = todayDateString();
        if (data.lastDailyDate === yesterdayDateString()) {
          data.streak += 1;
        } else if (data.lastDailyDate !== today) {
          data.streak = 1;
        }
        data.lastDailyDate = today;
        data.lastDailyResult = { score, words, tiles, timeLeft };
      }

      save();
    },
  };
})();

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
  mode: "practice", // "practice" | "daily"
  dailySeedDate: null,

  listeners: {
    onTilesChanged: null,
    onTimerTick: null,
    onRoundEnd: null,
    onWordAccepted: null,
    onWordRejected: null,
    onBoardFull: null,
  },

  // `mode` is "practice" (Math.random shuffle, unlimited replays) or
  // "daily" (shuffle seeded from today's date — same for every player
  // who makes the same V/C pick sequence today).
  newRound(mode = "practice") {
    this.mode = mode;
    let rng = Math.random;
    if (mode === "daily") {
      this.dailySeedDate = todayDateString();
      rng = mulberry32(seedFromDateString(this.dailySeedDate));
    } else {
      this.dailySeedDate = null;
    }
    this.vowelBag = shuffle(buildBag(VOWEL_POOL), rng);
    this.consonantBag = shuffle(buildBag(CONSONANT_POOL), rng);
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

  // Instantly fills every remaining slot with a realistic vowel/consonant
  // mix (targets ~4-in-9 vowels overall, like a typical Countdown board),
  // respecting whatever's already been picked and each bag's remaining
  // supply. Returns the letters added, in draw order.
  autoFillRemaining() {
    const added = [];
    // A real Countdown board typically runs 3-6 vowels out of 9 — pick a
    // target per fill (not a hard-coded 4) so boards vary naturally
    // instead of always converging on the exact same split.
    const targetVowels = 3 + Math.floor(Math.random() * 4); // 3..6
    while (this.canPick()) {
      const vowelsSoFar = this.tiles.filter((l) => "AEIOU".includes(l)).length;
      const slotsLeft = TILE_COUNT - this.tiles.length;
      const vowelsStillNeeded = Math.max(targetVowels - vowelsSoFar, 0);
      // Weighted coin flip: favor vowels only up to the target, and only
      // if there's actually room left to still hit it.
      const wantVowel =
        vowelsStillNeeded > 0 && (vowelsStillNeeded >= slotsLeft || Math.random() < vowelsStillNeeded / slotsLeft);

      let letter = wantVowel ? drawFrom(this.vowelBag) : drawFrom(this.consonantBag);
      // Fall back to whichever bag still has letters if the preferred one is empty.
      if (!letter) letter = drawFrom(this.vowelBag) || drawFrom(this.consonantBag);
      if (!letter) break;

      this._addTile(letter);
      added.push(letter);
    }
    return added;
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
      timeLeft: Math.max(this.timeRemaining, 0),
      mode: this.mode,
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
  const autoFillBtn = document.getElementById("auto-fill");
  const timerEl = document.getElementById("timer");
  const timerRingEl = document.getElementById("timer-ring-progress");
  const TIMER_RING_CIRCUMFERENCE = 263.9;
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
  const helpToggleBtn = document.getElementById("help-toggle");
  const helpCloseBtn = document.getElementById("help-close");
  const helpPanel = document.getElementById("help-panel");
  const modeSelectEl = document.getElementById("mode-select");
  const modePracticeBtn = document.getElementById("mode-practice");
  const modeDailyBtn = document.getElementById("mode-daily");
  const scoreboardEl = document.getElementById("scoreboard");
  const gameplaySectionsEl = document.getElementById("gameplay-sections");
  const dailyLockedNoticeEl = document.getElementById("daily-locked-notice");
  const dailyLockedScoreEl = document.getElementById("daily-locked-score");
  const dailyLockedTilesEl = document.getElementById("daily-locked-tiles");
  const dailyLockedWordsEl = document.getElementById("daily-locked-words");
  const shareResultBtn = document.getElementById("share-result");
  const playAgainBtn = document.getElementById("play-again");
  const statsToggleBtn = document.getElementById("stats-toggle");
  const statsCloseBtn = document.getElementById("stats-close");
  const statsPanel = document.getElementById("stats-panel");
  const statGamesPlayedEl = document.getElementById("stat-games-played");
  const statStreakEl = document.getElementById("stat-streak");
  const statBestPointsEl = document.getElementById("stat-best-points");
  const statBestWordEl = document.getElementById("stat-best-word");

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
    if (autoFillBtn) autoFillBtn.disabled = remaining === 0;
  }

  let lastRenderedTime = ROUND_SECONDS;

  function renderTimer(t) {
    const clamped = Math.max(t, 0);
    if (timerEl) {
      timerEl.textContent = String(clamped).padStart(2, "0");
      timerEl.classList.toggle("timer-warning", t <= 5 && t > 0);
    }
    if (timerRingEl) {
      const fraction = clamped / ROUND_SECONDS;
      const offset = TIMER_RING_CIRCUMFERENCE * (1 - fraction);
      timerRingEl.style.strokeDashoffset = String(offset);
      timerRingEl.classList.remove("timer-ring-amber", "timer-ring-red");
      if (t <= 5) {
        timerRingEl.classList.add("timer-ring-red");
      } else if (t <= 15) {
        timerRingEl.classList.add("timer-ring-amber");
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
      // Guarantee the input (and thus the keyboard's target) stays on
      // screen — mobile browsers don't always auto-scroll a focused
      // field clear of the virtual keyboard on their own.
      wordInput.scrollIntoView({ block: "center", behavior: "smooth" });
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

  let lastRoundResult = null;

  GameState.on("onRoundEnd", ({ score, words, rejected, bestWord, tiles, timeLeft, mode }) => {
    AudioEngine.buzzer();
    if (wordInput) wordInput.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    if (vowelBtn) vowelBtn.disabled = true;
    if (consonantBtn) consonantBtn.disabled = true;
    if (resultsPanel) resultsPanel.classList.remove("hidden");
    if (finalScoreEl) finalScoreEl.textContent = String(score);

    lastRoundResult = { score, words, tiles, timeLeft, mode };
    Stats.recordRoundResult({ score, words, tiles, timeLeft, isDaily: mode === "daily" });
    renderStats();

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

  if (autoFillBtn) {
    autoFillBtn.addEventListener("click", () => {
      GameState.autoFillRemaining();
    });
  }

  document.addEventListener("keydown", (e) => {
    // Don't hijack V/C while the player is typing a word or a modal is open.
    if (document.activeElement === wordInput) return;
    if (helpPanel && !helpPanel.classList.contains("hidden")) return;
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

  function showModeSelect() {
    if (resultsPanel) resultsPanel.classList.add("hidden");
    if (Stats.hasPlayedDailyToday()) {
      showDailyLocked();
      return;
    }
    if (modeSelectEl) modeSelectEl.classList.remove("hidden");
    if (scoreboardEl) scoreboardEl.classList.add("hidden");
    if (gameplaySectionsEl) gameplaySectionsEl.classList.add("hidden");
    if (dailyLockedNoticeEl) dailyLockedNoticeEl.classList.add("hidden");
  }

  function showDailyLocked() {
    if (modeSelectEl) modeSelectEl.classList.remove("hidden");
    if (scoreboardEl) scoreboardEl.classList.add("hidden");
    if (gameplaySectionsEl) gameplaySectionsEl.classList.add("hidden");
    if (dailyLockedNoticeEl) {
      dailyLockedNoticeEl.classList.remove("hidden");
      const result = Stats.getDailyResult();
      if (dailyLockedScoreEl) dailyLockedScoreEl.textContent = String(result ? result.score : 0);

      if (dailyLockedTilesEl) {
        dailyLockedTilesEl.innerHTML = "";
        const tiles = result ? result.tiles : [];
        tiles.forEach((letter) => {
          const div = document.createElement("div");
          div.className = "tile tile-filled";
          div.textContent = letter;
          dailyLockedTilesEl.appendChild(div);
        });
      }

      if (dailyLockedWordsEl) {
        dailyLockedWordsEl.innerHTML = "";
        const words = result ? result.words : [];
        if (words.length === 0) {
          const li = document.createElement("li");
          li.textContent = "No words found today.";
          li.style.opacity = "0.6";
          dailyLockedWordsEl.appendChild(li);
        } else {
          words.forEach((w) => {
            const li = document.createElement("li");
            li.textContent = `${w.toUpperCase()} (+${scoreForWord(w)})`;
            dailyLockedWordsEl.appendChild(li);
          });
        }
      }
    }
  }

  function startRound(mode) {
    if (mode === "daily" && Stats.hasPlayedDailyToday()) {
      if (resultsPanel) resultsPanel.classList.add("hidden");
      showDailyLocked();
      return;
    }
    if (modeSelectEl) modeSelectEl.classList.add("hidden");
    if (dailyLockedNoticeEl) dailyLockedNoticeEl.classList.add("hidden");
    if (scoreboardEl) scoreboardEl.classList.remove("hidden");
    if (gameplaySectionsEl) gameplaySectionsEl.classList.remove("hidden");

    GameState.newRound(mode);
    renderTiles();
    if (timerEl) timerEl.classList.remove("timer-warning");
    renderTimer(ROUND_SECONDS);
    renderScore();
    renderFoundWords();
    renderFeedback(
      mode === "daily" ? "Daily Challenge — pick 9 letters to begin." : "Pick 9 letters to begin.",
      "info"
    );
    if (wordInput) {
      wordInput.value = "";
      wordInput.disabled = true;
    }
    if (submitBtn) submitBtn.disabled = true;
    if (resultsPanel) resultsPanel.classList.add("hidden");
  }

  if (modePracticeBtn) modePracticeBtn.addEventListener("click", () => startRound("practice"));
  if (modeDailyBtn) modeDailyBtn.addEventListener("click", () => startRound("daily"));

  // "Change Mode" (scoreboard) always returns to mode-select, respecting
  // today's daily lock if the player switches back to Daily.
  if (newRoundBtn) newRoundBtn.addEventListener("click", showModeSelect);

  // "Play Again" restarts whatever mode the just-finished round was in.
  if (playAgainBtn) {
    playAgainBtn.addEventListener("click", () => {
      const mode = lastRoundResult ? lastRoundResult.mode : "practice";
      startRound(mode);
    });
  }

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

  function openHelp() {
    if (helpPanel) helpPanel.classList.remove("hidden");
  }

  function closeHelp() {
    if (helpPanel) helpPanel.classList.add("hidden");
  }

  if (helpToggleBtn) helpToggleBtn.addEventListener("click", openHelp);
  if (helpCloseBtn) helpCloseBtn.addEventListener("click", closeHelp);
  if (helpPanel) {
    helpPanel.addEventListener("click", (e) => {
      if (e.target === helpPanel) closeHelp();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && helpPanel && !helpPanel.classList.contains("hidden")) {
      closeHelp();
    }
  });

  function renderStats() {
    const stats = Stats.get();
    if (statGamesPlayedEl) statGamesPlayedEl.textContent = String(stats.gamesPlayed);
    if (statStreakEl) statStreakEl.textContent = String(stats.streak);
    if (statBestPointsEl) statBestPointsEl.textContent = String(stats.bestWord ? stats.bestWord.points : 0);
    if (statBestWordEl) statBestWordEl.textContent = stats.bestWord ? stats.bestWord.word.toUpperCase() : "—";
  }

  function openStats() {
    renderStats();
    if (statsPanel) statsPanel.classList.remove("hidden");
  }

  function closeStats() {
    if (statsPanel) statsPanel.classList.add("hidden");
  }

  if (statsToggleBtn) statsToggleBtn.addEventListener("click", openStats);
  if (statsCloseBtn) statsCloseBtn.addEventListener("click", closeStats);
  if (statsPanel) {
    statsPanel.addEventListener("click", (e) => {
      if (e.target === statsPanel) closeStats();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && statsPanel && !statsPanel.classList.contains("hidden")) {
      closeStats();
    }
  });

  const SITE_URL = "https://4orthwords.march4orthdesign.com/";

  function buildShareText() {
    if (!lastRoundResult) return "";
    const { score, timeLeft, mode, words } = lastRoundResult;
    const modeLabel = mode === "daily" ? `Daily Challenge (${todayDateString()})` : "Infinite Practice";
    // Spoiler-free: word count and length "blocks" only, never the words themselves.
    const blocks = words.length
      ? words.map((w) => "🟨".repeat(Math.min(w.length, 9))).join("\n")
      : "⬛".repeat(9);
    return [
      `4orthwords — ${modeLabel}`,
      `Score: ${score} pts  •  ${words.length} word${words.length === 1 ? "" : "s"}  •  ${timeLeft}s left`,
      blocks,
      SITE_URL,
    ].join("\n");
  }

  async function shareResult() {
    const text = buildShareText();
    if (!text) return;

    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        // User cancelled the share sheet or it failed — fall through to clipboard.
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      renderFeedback("Result copied to clipboard!", "good");
    } catch (e) {
      renderFeedback("Couldn't copy — try again.", "bad");
    }
  }

  if (shareResultBtn) shareResultBtn.addEventListener("click", shareResult);

  if (Stats.hasPlayedDailyToday()) {
    showDailyLocked();
  } else {
    showModeSelect();
  }
});
