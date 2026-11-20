/* Simple connections - how to play, and a practice puzzle.

   The practice puzzle runs entirely in this page. Its answers are below in
   plain sight, on purpose: it's a demo that never counts and never touches
   the real game. It follows the real board's rules (four mistakes, "one
   away", hints for a point, the same points formula as the database's
   points_for), and shows what the puzzle is worth as you play, so the
   scoring makes sense before the game starts. The real puzzles never come
   near this page; their answers stay in the database. */

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var el = SC.el;

  // One group of each kind the game uses, easiest first. Very easy on
  // purpose, with two gentle traps that earn a "One away": "Door" makes a
  // doorman but is needed for keys, and "Super" can pass for big.
  // This page is public: never use a word or group from the real puzzles
  // (supabase/puzzles.sql) here.
  var GROUPS = [
    { level: 1, title: "Fruit", words: ["Apple", "Banana", "Cherry", "Lemon"] },              // members of a set
    { level: 2, title: "Another word for big", words: ["Large", "Huge", "Giant", "Vast"] },   // same meaning
    { level: 3, title: "___ man", words: ["Snow", "Post", "Fire", "Super"] },                 // fill in the blank
    { level: 4, title: "Things with keys", words: ["Piano", "Door", "Map", "Laptop"] }        // a hidden link
  ];
  var MAX_MISTAKES = 4;
  var MAX_HINTS = 3;

  var s;               // order, solved, hints, mistakes, tried, status
  var selected = [];
  var asking = false;  // the "reveal a group name?" step is open
  var busy = false;    // a wrong guess is shaking
  var shown = {};      // group and hint bars on screen at the last draw
  var toastTimer = null;

  /* ------------------------------------------------------------ game */

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function fresh() {
    var words = [];
    GROUPS.forEach(function (g) { words = words.concat(g.words); });
    s = { order: shuffle(words), solved: [], hints: [], mistakes: 0, tried: {}, status: "playing" };
    selected = [];
    asking = false;
    busy = false;
    shown = {};
  }

  function groupOf(word) {
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].words.indexOf(word) >= 0) return i;
    }
    return -1;
  }

  function onBoard() {
    return s.order.filter(function (w) { return s.solved.indexOf(groupOf(w)) < 0; });
  }

  // The game's rule: groups found, capped at 4 - mistakes - hints, never below 0.
  function points(found) {
    return Math.max(0, Math.min(found, MAX_MISTAKES - s.mistakes - s.hints.length));
  }

  // The easiest group not found and not hinted yet, or -1 if no hint is allowed.
  function hintPick() {
    if (s.status !== "playing" || s.hints.length >= MAX_HINTS) return -1;
    if (GROUPS.length - s.solved.length < 2) return -1;   // never for the last group
    var pick = -1;
    GROUPS.forEach(function (g, i) {
      if (s.solved.indexOf(i) >= 0 || s.hints.indexOf(i) >= 0) return;
      if (pick < 0 || g.level < GROUPS[pick].level) pick = i;
    });
    return pick;
  }

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  /* ---------------------------------------------------------- render */

  function bar(g, missed) {
    var d = el("div", "solved g" + g.level + (missed ? " missed" : ""));
    d.appendChild(el("h3", null, g.title));
    d.appendChild(el("p", null, g.words.join(", ")));
    return d;
  }

  function hintBar(g) {
    var d = el("div", "hintbar");
    d.appendChild(el("span", "swatch g" + g.level));
    d.appendChild(el("span", "k", "Hint"));
    var t = el("span", null, "One group is ");
    t.appendChild(el("b", null, g.title));
    d.appendChild(t);
    return d;
  }

  function render() {
    var over = s.status !== "playing";
    $("prSub").textContent = s.status === "solved" ? "Puzzle complete."
      : s.status === "failed" ? "Out of guesses." : "Create four groups of four.";

    var board = $("prBoard");
    board.innerHTML = "";
    // The board is rebuilt on every tap. Only bars that are new since the
    // last draw play their entrance; the rest would blink.
    var was = shown;
    shown = {};
    var place = function (node, key) {
      if (was[key]) node.style.animation = "none";
      shown[key] = true;
      board.appendChild(node);
    };
    s.solved.forEach(function (i) { place(bar(GROUPS[i], false), "s" + i); });
    if (s.status === "failed") {
      GROUPS.forEach(function (g, i) { if (s.solved.indexOf(i) < 0) place(bar(g, true), "m" + i); });
    }
    if (!over) {
      s.hints.forEach(function (i) { if (s.solved.indexOf(i) < 0) place(hintBar(GROUPS[i]), "h" + i); });
      var grid = el("div", "grid");
      onBoard().forEach(function (w) {
        var b = el("button", "tile" + (w.length > 8 ? " long" : ""), w);
        b.type = "button";
        b.setAttribute("aria-pressed", selected.indexOf(w) >= 0 ? "true" : "false");
        b.disabled = busy;
        b.onclick = function () { toggle(w); };
        grid.appendChild(b);
      });
      board.appendChild(grid);
    }

    var dots = $("prDots");
    dots.innerHTML = "";
    for (var i = 0; i < MAX_MISTAKES; i++) {
      var d = el("i");
      if (i >= MAX_MISTAKES - s.mistakes) d.className = "used";
      dots.appendChild(d);
    }
    dots.setAttribute("aria-label", (MAX_MISTAKES - s.mistakes) + " mistakes left");

    // What the puzzle is worth right now, both ways it could end.
    var worth = $("prWorth");
    worth.innerHTML = "";
    worth.appendChild(el("span", null, "Solve it now: " + plural(points(GROUPS.length), "point")));
    worth.appendChild(document.createTextNode(" · "));
    worth.appendChild(el("span", null, "If time ran out now: " + plural(points(s.solved.length), "point")));

    var pick = hintPick();
    if (pick < 0) asking = false;
    $("prPlay").hidden = over;
    $("prSubmit").disabled = busy || selected.length !== 4;
    $("prClear").disabled = busy || selected.length === 0;
    $("prShuffle").disabled = busy;
    $("prHint").disabled = busy || pick < 0;
    $("prHint").title = pick >= 0 ? "" : s.hints.length >= MAX_HINTS ? "No more hints on this puzzle"
      : GROUPS.length - s.solved.length < 2 ? "No hint for the last group" : "You've had a hint for every group left";
    $("prHintAsk").hidden = !asking;

    $("prEnd").hidden = !over;
    $("prLeaveRow").hidden = over;
    if (over) {
      var pts = s.status === "solved" ? points(GROUPS.length) : 0;
      $("prEndMsg").textContent = endMessage(pts);
      $("prEndPts").textContent = "That's " + plural(pts, "point") + " out of 4. This one was practice, so it doesn't count.";
    }
  }

  function endMessage(pts) {
    if (s.status === "failed") return "Out of guesses. Here are the groups.";
    var hints = s.hints.length;
    if (s.mistakes === 0 && hints === 0) return "Perfect. Solved with no mistakes: 4 points.";
    var how = s.mistakes === 0 ? "no mistakes" : plural(s.mistakes, "mistake");
    if (hints) how += " and " + plural(hints, "hint");
    return "Solved with " + how + ": " + plural(pts, "point") + ".";
  }

  /* ------------------------------------------------------------ play */

  function toggle(w) {
    if (busy || s.status !== "playing") return;
    var at = selected.indexOf(w);
    if (at >= 0) selected.splice(at, 1);
    else if (selected.length < 4) selected.push(w);
    render();
  }

  function toast(msg) {
    var t = $("prToast");
    t.innerHTML = "";
    t.appendChild(el("span", null, msg));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.innerHTML = ""; }, 2400);
  }

  function shakeSelected() {
    var tiles = document.querySelectorAll('#prBoard .tile[aria-pressed="true"]');
    Array.prototype.forEach.call(tiles, function (node) {
      node.classList.remove("shake");
      void node.offsetWidth;
      node.classList.add("shake");
    });
  }

  function submit() {
    if (busy || selected.length !== 4 || s.status !== "playing") return;
    var key = selected.slice().sort().join("|");
    if (s.tried[key]) { toast("Already guessed."); return; }
    s.tried[key] = true;

    var match = -1, best = 0;
    GROUPS.forEach(function (g, i) {
      if (s.solved.indexOf(i) >= 0) return;
      var hits = selected.filter(function (w) { return g.words.indexOf(w) >= 0; }).length;
      if (hits === 4) match = i;
      best = Math.max(best, hits);
    });

    if (match >= 0) {
      s.solved.push(match);
      selected = [];
      if (s.solved.length === GROUPS.length) s.status = "solved";
      else toast("Correct!");
      render();
      return;
    }

    // Wrong: shake the tiles first, then move on.
    s.mistakes++;
    if (s.mistakes >= MAX_MISTAKES) s.status = "failed";
    shakeSelected();
    toast(best === 3 ? "One away…" : "Not a group.");
    busy = true;
    $("prSubmit").disabled = true;
    setTimeout(function () {
      busy = false;
      selected = [];
      render();
    }, s.status === "failed" ? 900 : 420);
  }

  $("prSubmit").onclick = submit;
  $("prClear").onclick = function () { selected = []; render(); };
  $("prShuffle").onclick = function () { shuffle(s.order); render(); };

  $("prHint").onclick = function () {
    if (hintPick() < 0) return;
    asking = true;
    render();
    $("prHintYes").focus();
  };
  $("prHintNo").onclick = function () {
    asking = false;
    render();
    $("prHint").focus();
  };
  $("prHintYes").onclick = function () {
    var i = hintPick();
    if (i < 0) return;
    s.hints.push(i);
    asking = false;
    render();
    toast("Hint: one group is " + GROUPS[i].title + ". −1 point.");
  };

  document.addEventListener("keydown", function (e) {
    if ($("practice").hidden || e.target.tagName === "INPUT") return;
    if (e.target.tagName === "BUTTON" && !e.target.classList.contains("tile")) return;
    if (e.key === "Enter" && !$("prSubmit").disabled) {
      e.preventDefault();
      submit();
    }
  });

  /* ----------------------------------------------------------- views */

  function showGuide() {
    $("practice").hidden = true;
    $("guide").hidden = false;
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    window.scrollTo(0, 0);
  }

  function showPractice() {
    fresh();
    $("guide").hidden = true;
    $("practice").hidden = false;
    history.replaceState(null, "", location.pathname + location.search + "#practice");
    render();
    window.scrollTo(0, 0);
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-practice]"), function (b) {
    b.onclick = showPractice;
  });
  $("prLeave").onclick = showGuide;
  $("prDone").onclick = showGuide;
  $("prAgain").onclick = function () { fresh(); render(); window.scrollTo(0, 0); };

  // Today's game, from the database, if this copy is connected to one.
  if (SC.configured()) {
    SC.rpc("sc_info").then(function (d) {
      var n = d.puzzle_count;
      if (!n) return;
      $("today").textContent = "Today's game has " + SC.numberWord(n) + (n === 1 ? " puzzle" : " puzzles") +
        ", worth up to " + SC.numberWord(d.max_points) + " points." +
        (d.game && d.game.hints_enabled === false ? " Hints are switched off for it." : "");
      $("todayTotal").textContent = "Today: " + plural(n, "puzzle") + ", so up to " + d.max_points + " points.";
      $("todayTotal").hidden = false;
    }).catch(function () {});
  }

  if (location.hash === "#practice") showPractice();
})();
