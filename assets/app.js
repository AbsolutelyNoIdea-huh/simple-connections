/* Simple connections - player page.

   The browser holds no answers. It knows the 16 words of the puzzle in
   play, the groups this team has already found, and whatever the database
   said about its own guesses. Every guess is judged in the database
   (sc_guess in supabase/setup.sql). */

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var el = SC.el;

  var state = null;       // latest team payload from the database
  var info = null;        // latest sc_info payload, before joining
  var view = 0;           // puzzle index on screen, or "card" for the finish screen
  var selected = [];      // words selected right now (client-side only)
  var busy = false;
  var codeMode = false;   // join form: true = rejoining with a code
  var toastTimer = null;
  var pollTimer = null;
  var infoTimer = null;
  var lastPlayable = null;
  var hintAsking = false; // the "reveal a group name for a point?" step is open

  var SCREENS = ["setup", "join", "lobby", "game", "finale"];
  function showOnly(id) {
    SCREENS.forEach(function (s) { $(s).hidden = s !== id; });
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ------------------------------------------------------------- join */

  function showJoinError(msg) {
    $("joinError").textContent = msg || "";
    $("joinError").hidden = !msg;
  }

  function setJoinMode(useCode) {
    codeMode = useCode;
    $("nameField").hidden = useCode;
    $("codeField").hidden = !useCode;
    $("startBtn").textContent = useCode ? "Rejoin" : "Join";
    $("haveCodeBtn").textContent = useCode ? "New team instead" : "I already have a code";
    $("joinNote").textContent = useCode
      ? "Your code is the five characters that were shown next to your team name."
      : "You'll get a short code when you join. Keep it: it lets you carry on if you refresh or switch device.";
    (useCode ? $("teamCode") : $("teamName")).focus();
    renderInfo();
  }

  function showJoin(message) {
    state = null;
    clearTimeout(pollTimer);
    $("whoami").hidden = true;
    $("tabs").hidden = true;
    $("curtain").hidden = true;
    showOnly("join");
    showJoinError(message || "");
    loadInfo();
  }

  // What the game is doing right now, shown above the join form.
  function loadInfo() {
    clearTimeout(infoTimer);
    if (state) return;
    SC.rpc("sc_info").then(function (data) {
      info = data;
      renderInfo();
    }).catch(function (err) {
      info = null;
      var line = $("gameState");
      line.hidden = false;
      line.textContent = err.code === "not_set_up"
        ? "The game's database isn't set up yet. Let the host know."
        : "Can't reach the game right now. Retrying…";
    }).then(function () {
      if (!state) infoTimer = setTimeout(loadInfo, 5000);
    });
  }

  function renderInfo() {
    if (!info || state) return;
    var g = info.game;
    var n = info.puzzle_count;
    showHintRules(g.hints_enabled);

    if (n > 0) {
      $("introPuzzles").textContent = cap(SC.numberWord(n)) + (n === 1 ? " puzzle" : " puzzles");
      $("introPoints").textContent = cap(SC.numberWord(info.max_points)) + " points are";
    }

    var line = $("gameState");
    line.hidden = false;
    line.innerHTML = "";
    var canJoin = n > 0 && g.accepting_joins;
    if (n === 0) {
      line.appendChild(el("b", null, "Not ready yet."));
      line.appendChild(document.createTextNode("The host is still setting up. Check back in a moment."));
    } else if (g.status === "lobby") {
      var waiting = info.teams_joined || 0;
      line.appendChild(el("b", null, "Not started yet."));
      line.appendChild(document.createTextNode(waiting
        ? (waiting === 1 ? "1 team is" : waiting + " teams are") + " in the lobby. Join now and you'll all start together."
        : "Join now and you'll all start together."));
    } else if (g.status === "live") {
      var left = SC.timeLeft(g);
      if (left === 0 && g.lock_at_zero) {
        line.appendChild(el("b", null, "Time's up."));
        line.appendChild(document.createTextNode("The host is closing the round."));
      } else {
        line.appendChild(el("b", null, "Under way."));
        line.appendChild(document.createTextNode(left === null
          ? "Join now and start straight away."
          : "Join now and start straight away: " + SC.clock(left) + " left."));
      }
    } else if (g.status === "paused") {
      line.appendChild(el("b", null, "Paused."));
      line.appendChild(document.createTextNode("New teams can join as soon as the host resumes."));
    } else if (g.status === "frozen") {
      line.appendChild(el("b", null, "This round has finished."));
      var a = el("a", null, "See the scoreboard");
      a.href = "scoreboard.html";
      line.appendChild(a);
    }
    $("startBtn").disabled = busy || (!codeMode && !canJoin);
  }

  $("haveCodeBtn").onclick = function () {
    showJoinError("");
    setJoinMode(!codeMode);
  };

  var JOIN_ERRORS = {
    unknown_team: "We don't recognise that code. Check it and try again.",
    name_required: "Please enter a team name.",
    bad_name: "Please keep the name to 32 characters or fewer.",
    paused: "The game is paused. Try again when the host resumes.",
    round_over: "This round has finished. The host will open a new one if there's another.",
    time_up: "Time's up for this round, so new teams can't join. Wait for the next one.",
    full: "The game is full. Ask the host to make room.",
    not_ready: "The game isn't ready yet. Try again in a moment.",
    not_set_up: "The game's database isn't set up yet. Let the host know.",
    network: "Can't reach the game. Check your connection and try again."
  };

  $("joinForm").onsubmit = function (e) {
    e.preventDefault();
    if (busy) return;
    showJoinError("");

    // Only the field for the current mode is read, so a code typed and then
    // abandoned can't quietly override a new team name, or the other way round.
    var code = codeMode ? $("teamCode").value.trim().toUpperCase() : "";
    var name = codeMode ? "" : $("teamName").value.trim();
    if (codeMode && !code) return showJoinError("Please enter your team code.");
    if (!codeMode && !name) return showJoinError("Please enter a team name.");

    busy = true;
    $("startBtn").disabled = true;
    var req = codeMode
      ? SC.rpc("sc_state", { p_code: code })
      : SC.rpc("sc_join", { p_name: name });

    req.then(function (data) {
      busy = false;
      clearTimeout(infoTimer);
      adopt(data);
    }).catch(function (err) {
      busy = false;
      if (err.code === "name_taken") {
        setJoinMode(true);
        showJoinError("That name is already taken. If it's your team, enter your team code.");
      } else {
        showJoinError(JOIN_ERRORS[err.code] || "Something went wrong. Try again.");
      }
      $("startBtn").disabled = false;
      loadInfo();
    });
  };

  /* ----------------------------------------------------------- render */

  function playable() {
    if (!state) return false;
    var g = state.game;
    if (g.status !== "live") return false;
    return !(g.lock_at_zero && SC.timeLeft(g) === 0);
  }

  function finaleAvailable() {
    return state.all_done || state.game.status === "frozen";
  }

  // Take a new payload from the database, keeping the puzzle on screen
  // unless the move between game states calls for another.
  function adopt(data) {
    var before = state;
    state = data;
    SC.local.set("code", state.team.code);

    var was = before ? before.game.status : null;
    var now = state.game.status;
    if (!before) {
      view = finaleAvailable() ? "card" : (state.current === null ? 0 : state.current);
    } else if (now === "frozen" && was !== "frozen") {
      view = "card";
      selected = [];
    } else if (was === "frozen" && now !== "frozen" && view === "card" && !state.all_done) {
      view = state.current === null ? 0 : state.current;
    }
    if (view === "card" && !finaleAvailable()) view = state.current === null ? 0 : state.current;
    if (view !== "card") {
      if (view >= state.puzzle_count) view = Math.max(0, state.puzzle_count - 1);
      var p = state.puzzles[view];
      if (p && p.status === "locked" && state.current !== null) view = state.current;
    }
    // Another device of the same team may have found a group meanwhile:
    // drop any selected word that's no longer on the board.
    var shown = view === "card" ? [] : state.puzzles[view].words;
    selected = selected.filter(function (w) { return shown.indexOf(w) >= 0; });
    render();
    schedulePoll();
  }

  function render() {
    if (!state) return;
    var g = state.game;
    $("whoami").hidden = false;
    $("whoName").textContent = state.team.name;
    $("whoCode").textContent = state.team.code;
    $("curtain").hidden = g.status !== "paused";
    showHintRules(g.hints_enabled);
    renderTimer();
    lastPlayable = playable();

    if (g.status === "lobby") {
      showOnly("lobby");
      $("tabs").hidden = true;
      renderLobby();
      return;
    }
    lobbySeen = null;
    if (view === "card") {
      showFinale();
      return;
    }
    showOnly("game");

    var p = state.puzzles[view];
    var over = p.status === "solved" || p.status === "failed";
    var canPlay = lastPlayable && p.status === "playing";

    // The puzzle's theme is the headline: "Puzzle 3 of 6" above "Sports."
    $("pKicker").textContent = "Puzzle " + (view + 1) + " of " + state.puzzle_count;
    $("pTitle").textContent = headline(p.name);
    $("pSub").textContent = over ? "Puzzle complete." : "Create four groups of four.";

    var timeUp = !over && g.timer && SC.timeLeft(g) === 0 && g.status === "live";
    $("timeUp").hidden = !(timeUp || (g.status === "frozen" && !over));
    if (g.status === "frozen") {
      $("timeUpTitle").textContent = "Round over.";
      $("timeUpMsg").textContent = "The host has closed the round. This board is how you left it.";
    } else {
      $("timeUpTitle").textContent = "Time's up.";
      $("timeUpMsg").textContent = g.lock_at_zero
        ? "The host is about to close the round."
        : "Keep going until the host closes the round.";
    }

    var board = $("board");
    board.innerHTML = "";
    board.className = "board" + (canPlay || over ? "" : " locked");
    p.solved.forEach(function (grp) { board.appendChild(groupBar(grp, false)); });
    p.missing.forEach(function (grp) { board.appendChild(groupBar(grp, true)); });
    (p.hints || []).forEach(function (h) { board.appendChild(hintBar(h)); });

    if (p.words.length) {
      var grid = el("div", "grid");
      p.words.forEach(function (w) {
        var b = el("button", "tile" + (w.length > 8 ? " long" : ""), w);
        b.type = "button";
        b.setAttribute("aria-pressed", selected.indexOf(w) >= 0 ? "true" : "false");
        b.disabled = !canPlay;
        b.onclick = function () { toggle(w); };
        grid.appendChild(b);
      });
      board.appendChild(grid);
    }

    var dots = $("dots");
    dots.innerHTML = "";
    for (var i = 0; i < state.max_mistakes; i++) {
      var d = el("i");
      if (i >= state.max_mistakes - p.mistakes) d.className = "used";
      dots.appendChild(d);
    }
    dots.setAttribute("aria-label", (state.max_mistakes - p.mistakes) + " mistakes left");

    $("play").hidden = over || p.status === "locked" || g.status === "frozen";
    $("submitBtn").disabled = selected.length !== 4 || busy || !canPlay;
    $("clearBtn").disabled = selected.length === 0 || !canPlay;
    $("shuffleBtn").disabled = !canPlay;
    $("end").hidden = !over;

    // Hints: the button, the "are you sure?" step, and what's been spent.
    var hintsOn = !!g.hints_enabled;
    $("hintBtn").hidden = !hintsOn;
    $("hintBtn").disabled = busy || !canPlay || !p.hint_available;
    $("hintBtn").title = p.hint_available ? "" : (p.hints_used >= state.max_hints
      ? "No more hints on this puzzle" : "No hint for the last group");
    if (!(hintsOn && canPlay && p.hint_available)) hintAsking = false;
    $("hintAsk").hidden = !hintAsking;
    $("hintNote").hidden = !p.hints_used;
    $("hintNote").textContent = p.hints_used
      ? "Hints used on this puzzle: " + p.hints_used + " of " + state.max_hints +
        " (−" + p.hints_used + (p.hints_used === 1 ? " point)" : " points)")
      : "";

    if (over) {
      $("endMsg").textContent = endMessage(p);
      $("endPts").textContent = p.points + (p.points === 1 ? " point" : " points") +
        " · running total " + state.total_points + "/" + state.max_points;
      var last = state.current === null;
      $("nextBtn").textContent = last ? "Finish" : "Next: puzzle " + (state.current + 1);
      $("nextBtn").hidden = g.status === "frozen" && last;
    }

    renderTabs();
  }

  // The waiting room: this team, everyone else who has joined (names only,
  // in the order they arrived), and the host's go still to come. A team
  // that arrives after this screen first drew is animated in and announced
  // to screen readers; the first draw is quiet.
  var lobbySeen = null;   // names already on screen, or null before the first draw

  function renderLobby() {
    $("lobbyName").textContent = state.team.name;
    $("lobbyCode").textContent = state.team.code;

    // A teaser: the themes of today's puzzles, in order.
    var themes = $("themeList");
    themes.innerHTML = "";
    state.puzzles.forEach(function (p) { themes.appendChild(el("li", null, p.name)); });
    $("lobbyThemes").hidden = state.puzzles.length === 0;

    var teams = state.lobby_teams || [];
    var others = teams.filter(function (t) { return !t.you; }).length;
    $("lobbyCount").textContent = teams.length === 1 ? "1 team" : teams.length + " teams";
    $("lobbyAlone").hidden = others > 0;

    var first = lobbySeen === null;
    var seen = lobbySeen || {};
    var arrivals = [];
    var list = $("lobbyTeams");
    list.innerHTML = "";
    teams.forEach(function (t) {
      var li = el("li", t.you ? "you" : "");
      li.appendChild(el("span", null, t.name));
      if (t.you) li.appendChild(el("span", "tag", "You"));
      if (!first && !seen[t.name]) {
        li.className += " arrived";
        if (!t.you) arrivals.push(t.name);
      }
      list.appendChild(li);
    });

    lobbySeen = {};
    teams.forEach(function (t) { lobbySeen[t.name] = true; });
    if (arrivals.length) {
      $("lobbyAnnounce").textContent = arrivals.join(", ") + (arrivals.length === 1 ? " has" : " have") + " joined.";
    }
  }

  // A hinted group: its name and colour, never its words.
  function hintBar(h) {
    var d = el("div", "hintbar");
    d.appendChild(el("span", "swatch g" + h.level));
    d.appendChild(el("span", "k", "Hint"));
    var t = el("span", null, "One group is ");
    t.appendChild(el("b", null, h.title));
    d.appendChild(t);
    return d;
  }

  function showHintRules(on) {
    Array.prototype.forEach.call(document.querySelectorAll(".hint-rule"), function (s) {
      s.hidden = !on;
    });
  }

  function groupBar(g, missed) {
    var d = el("div", "solved g" + g.level + (missed ? " missed" : ""));
    d.appendChild(el("h3", null, g.title));
    d.appendChild(el("p", null, g.words.join(", ")));
    return d;
  }

  function renderTabs() {
    var t = $("tabs");
    t.hidden = false;
    t.innerHTML = "";
    state.puzzles.forEach(function (p, i) {
      var done = p.status === "solved" || p.status === "failed";
      // Numbers keep six tabs on one line, even on a phone; the theme is
      // in the tooltip and read out by screen readers.
      var b = el("button", "tab" + (done ? " done" : ""), String(i + 1));
      b.type = "button";
      b.title = "Puzzle " + (i + 1) + ": " + p.name;
      b.setAttribute("aria-label", "Puzzle " + (i + 1) + ": " + p.name + (done ? ", finished" : ""));
      b.setAttribute("aria-current", i === view ? "true" : "false");
      b.disabled = p.status === "locked";
      b.onclick = function () { view = i; selected = []; hintAsking = false; render(); };
      t.appendChild(b);
    });
    if (finaleAvailable()) {
      var c = el("button", "tab", "Your card");
      c.type = "button";
      c.setAttribute("aria-current", view === "card" ? "true" : "false");
      c.onclick = function () { view = "card"; selected = []; render(); };
      t.appendChild(c);
    }
  }

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function ordinal(n) {
    var s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // A theme as a headline: sentence case, ending in a full stop.
  function headline(name) {
    var t = String(name || "").trim();
    return /[.!?]$/.test(t) ? t : t + ".";
  }

  function endMessage(p) {
    if (p.status === "failed") return "Out of guesses. Here are the groups.";
    var hints = p.hints_used || 0;
    if (p.mistakes === 0 && hints === 0) return "Perfect. Solved with no mistakes: 4 points.";
    var how = p.mistakes === 0 ? "no mistakes" : plural(p.mistakes, "mistake");
    if (hints) how += " and " + plural(hints, "hint");
    return "Solved with " + how + ": " + plural(p.points, "point") + ".";
  }

  function showFinale() {
    showOnly("finale");
    var frozen = state.game.status === "frozen";
    $("finKicker").textContent = frozen ? "Round over" : "That's a wrap";
    $("finTitle").textContent = state.all_done ? "All done." : "Round over.";
    var placed = frozen && state.result;
    $("finLede").textContent = placed
      ? "The final scores are out."
      : frozen
        ? "The host has closed the round and saved the scores. Stay tuned for the reveal."
        : "Every group had one simple idea behind it. The trick was ignoring the words that looked like they fit. Wait for the host to reveal the scoreboard.";
    $("boardLink").hidden = !frozen;

    // Once the host publishes the scores: this team's final place.
    var rank = $("finRank");
    rank.hidden = !placed;
    if (placed) {
      var res = state.result;
      rank.className = "placing" + (res.rank <= 3 ? " top" : "");
      rank.textContent = res.rank === 1
        ? "You won! First of " + res.of + "."
        : "You came " + ordinal(res.rank) + " of " + res.of + ".";
    }

    var rows = $("cardRows");
    rows.innerHTML = "";
    state.puzzles.forEach(function (p, i) {
      var r = el("div", "cardrow");
      var how;
      if (p.status === "solved") {
        how = p.mistakes === 0 ? "solved, no mistakes" : "solved, " + plural(p.mistakes, "mistake");
      } else if (p.status === "failed") {
        how = "not solved";
      } else if (p.status === "playing") {
        how = "unfinished, " + p.solved.length + " of 4 groups";
      } else {
        how = "not reached";
      }
      if (p.hints_used) how += ", " + plural(p.hints_used, "hint");
      r.appendChild(el("span", null, "Puzzle " + (i + 1) + " · " + how));
      r.appendChild(el("b", null, String(p.points)));
      rows.appendChild(r);
    });
    var tot = el("div", "cardrow total");
    tot.appendChild(el("span", null, "Total"));
    tot.appendChild(el("b", null, state.total_points + " / " + state.max_points));
    rows.appendChild(tot);
    renderTabs();
  }

  function renderTimer() {
    var box = $("timer");
    var g = state && state.game;
    if (!g || !g.timer || g.status === "lobby" || g.status === "frozen") {
      box.hidden = true;
      return;
    }
    var left = SC.timeLeft(g);
    box.hidden = false;
    $("timerText").textContent = SC.clock(left);
    $("timerLabel").textContent = g.status === "paused" ? "Paused" : (left === 0 ? "Time's up" : "Time left");
    box.className = "timer" + (left === 0 ? " up" : (left < 60000 && g.status === "live" ? " low" : ""));
  }

  /* ------------------------------------------------------------- play */

  function toggle(w) {
    var p = state.puzzles[view];
    if (p.status !== "playing" || !playable()) return;
    var at = selected.indexOf(w);
    if (at >= 0) selected.splice(at, 1);
    else if (selected.length < 4) selected.push(w);
    render();
  }

  function toast(msg) {
    var t = $("toast");
    t.innerHTML = "";
    t.appendChild(el("span", null, msg));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.innerHTML = ""; }, 2200);
  }

  function shakeSelected() {
    var tiles = document.querySelectorAll('.tile[aria-pressed="true"]');
    Array.prototype.forEach.call(tiles, function (node) {
      node.classList.remove("shake");
      void node.offsetWidth;
      node.classList.add("shake");
    });
  }

  var GUESS_REFUSED = {
    time_up: "Time's up.",
    paused: "The host has paused the game.",
    round_over: "The round is over.",
    not_started: "The game hasn't started yet.",
    bad_guess: "That guess didn't go through. Try again."
  };

  function submit() {
    if (busy || selected.length !== 4 || view === "card") return;
    var p = state.puzzles[view];
    if (p.status !== "playing" || !playable()) return;

    busy = true;
    $("submitBtn").disabled = true;
    var sent = selected.slice();

    SC.rpc("sc_guess", { p_code: state.team.code, p_puzzle: view, p_words: sent })
      .then(function (res) {
        busy = false;
        if (res.outcome === "already_guessed") {
          toast("Already guessed.");
          render();
          return;
        }
        if (res.outcome === "correct") {
          selected = [];
          adopt(res.state);
          if (!res.puzzle_over) toast("Correct!");
          return;
        }
        // Wrong or one away: shake the tiles first, then apply the new state.
        shakeSelected();
        toast(res.outcome === "one_away" ? "One away…" : "Not a group.");
        setTimeout(function () {
          selected = [];
          adopt(res.state);
        }, res.puzzle_over ? 900 : 420);
      })
      .catch(function (err) {
        busy = false;
        if (err.code === "unknown_team") return kickOut();
        if (err.data && err.data.state) adopt(err.data.state);
        else if (err.code === "bad_guess" || err.code === "puzzle_locked") {
          selected = [];
          refresh();
        }
        if (GUESS_REFUSED[err.code]) toast(GUESS_REFUSED[err.code]);
        else if (err.code !== "puzzle_over" && err.code !== "puzzle_locked") {
          toast("Couldn't reach the game. Try again.");
        }
        render();
      });
  }

  function kickOut() {
    SC.local.remove("code");
    selected = [];
    showJoin("Your team is no longer in the game: the host removed it or started a new round. Join again below.");
  }

  $("submitBtn").onclick = submit;
  $("clearBtn").onclick = function () { selected = []; render(); };

  $("shuffleBtn").onclick = function () {
    var p = state.puzzles[view];
    var w = p.words.slice();
    for (var i = w.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = w[i]; w[i] = w[j]; w[j] = tmp;
    }
    p.words = w;
    render();
    // The database keeps the order of all 16; found words go first so a
    // refresh rebuilds the same board.
    var found = [];
    p.solved.forEach(function (grp) { found = found.concat(grp.words); });
    SC.rpc("sc_shuffle", { p_code: state.team.code, p_puzzle: view, p_words: found.concat(p.words) })
      .catch(function () {});
  };

  $("nextBtn").onclick = function () {
    hintAsking = false;
    if (state.current !== null) {
      view = state.current;
      selected = [];
      render();
      window.scrollTo(0, 0);
    } else {
      view = "card";
      render();
      window.scrollTo(0, 0);
    }
  };

  /* ------------------------------------------------------------ hints */

  var HINT_REFUSED = {
    no_hints: "No more hints on this puzzle.",
    hints_off: "The host has turned hints off."
  };

  $("hintBtn").onclick = function () {
    hintAsking = true;
    render();
    $("hintYes").focus();
  };

  $("hintNo").onclick = function () {
    hintAsking = false;
    render();
    $("hintBtn").focus();
  };

  $("hintYes").onclick = function () {
    if (busy || view === "card") return;
    var p = state.puzzles[view];
    if (p.status !== "playing" || !playable() || !p.hint_available) return;
    busy = true;
    $("hintYes").disabled = true;
    SC.rpc("sc_hint", { p_code: state.team.code, p_puzzle: view })
      .then(function (res) {
        busy = false;
        hintAsking = false;
        adopt(res.state);
        toast("Hint: one group is " + res.hint.title + ". −1 point.");
      })
      .catch(function (err) {
        busy = false;
        hintAsking = false;
        if (err.code === "unknown_team") return kickOut();
        if (err.data && err.data.state) adopt(err.data.state);
        toast(HINT_REFUSED[err.code] || GUESS_REFUSED[err.code] || "Couldn't reach the game. Try again.");
        render();
      })
      .then(function () { $("hintYes").disabled = false; });
  };

  document.addEventListener("keydown", function (e) {
    if ($("game").hidden || e.target.tagName === "INPUT") return;
    // Enter on a focused control (Reveal, Cancel, Shuffle…) presses that
    // control. It only submits a guess from the tiles or the page.
    if (e.target.tagName === "BUTTON" && !e.target.classList.contains("tile")) return;
    if (e.key === "Enter" && !$("submitBtn").disabled) {
      e.preventDefault();
      submit();
    }
  });

  /* ---------------------------------------------------------- polling */

  function signature(s) {
    var g = s.game, t = g.timer;
    return [g.status, g.lock_at_zero, g.hints_enabled,
            t ? [t.running, t.running ? t.ends_at : t.left_ms, t.total_s].join(",") : "none",
            s.current, s.all_done, s.total_points,
            s.result ? s.result.rank + "/" + s.result.of : "",
            (s.lobby_teams || []).map(function (x) { return x.name; }).join("\u0001")]
      .concat(s.puzzles.map(function (p) {
        return p.status + ":" + p.mistakes + ":" + p.solved.length + ":" + p.words.length +
               ":" + p.hints_used + ":" + p.hint_available;
      }))
      .join("|");
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!state) return;
    var g = state.game;
    var left = SC.timeLeft(g);
    var wait = 4000;
    if (g.status === "frozen") wait = 5000;
    else if (g.status !== "live" || (left !== null && left < 15000)) wait = 2500;
    pollTimer = setTimeout(refresh, wait);
  }

  function refresh() {
    if (!state) return;
    if (busy) return schedulePoll();
    var code = state.team.code;
    SC.rpc("sc_state", { p_code: code })
      .then(function (data) {
        if (!state || state.team.code !== code) return;
        if (signature(data) !== signature(state)) adopt(data);
      })
      .catch(function (err) {
        if (err.code === "unknown_team") kickOut();
      })
      .then(schedulePoll);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state) refresh();
  });

  // The countdown ticks locally between polls.
  setInterval(function () {
    if (state) {
      renderTimer();
      if (playable() !== lastPlayable) render();
    } else if (info && info.game.status === "live" && !$("join").hidden) {
      renderInfo();
    }
  }, 500);

  /* ------------------------------------------------------------- boot */

  function resume(code) {
    SC.rpc("sc_state", { p_code: code })
      .then(adopt)
      .catch(function (err) {
        if (err.code === "unknown_team") {
          SC.local.remove("code");
          showJoin();
        } else {
          showJoin(JOIN_ERRORS[err.code] || "Can't reach the game right now.");
          setTimeout(function () { if (!state) resume(code); }, 5000);
        }
      });
  }

  if (!SC.configured()) {
    showOnly("setup");
  } else {
    var saved = SC.local.get("code");
    if (saved) {
      resume(saved);
    } else {
      showJoin();
      $("teamName").focus();
    }
  }
})();
