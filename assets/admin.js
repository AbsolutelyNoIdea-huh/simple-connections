/* Simple connections - host console and presentation scoreboard.

   Signs in with the host passcode (checked in the database, which hands
   back a 12-hour session token), then reads the live standings every two
   seconds. Every button calls one sc_admin_* function in
   supabase/setup.sql, which answers with the console's fresh state. */

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var el = SC.el;

  var token = SC.session.get("admin");
  var latest = null;        // last payload from sc_admin_state
  var pollTimer = null;
  var minutesTouched = false;
  var tableSig = "";
  var savedSig = "";
  var stageTeams = null;    // the ranking on the presentation screen
  var revealed = 0;         // rows showing, counting up from last place

  function show(id) {
    ["setup", "login", "console"].forEach(function (s) { $(s).hidden = s !== id; });
  }

  /* ---------------------------------------------------------- messages */

  var ERRORS = {
    network: "Can't reach the database. Check your connection.",
    not_set_up: "The database isn't set up yet: run supabase/setup.sql in the Supabase SQL Editor.",
    server_error: "The database answered with an error. Try again.",
    bad_response: "The database gave an unexpected answer. Try again.",
    wrong_state: "The game had already moved on, so nothing changed. The console is up to date now.",
    no_puzzles: "No puzzles are loaded. Run supabase/puzzles.sql in the Supabase SQL Editor.",
    bad_timer: "A timer can run from 10 seconds to 24 hours.",
    not_found: "That saved scoreboard no longer exists."
  };

  var LOGIN_ERRORS = {
    bad_passcode: "That passcode isn't right.",
    locked: "Too many wrong passcodes. Wait 15 minutes, or clear the lock in Supabase (see the setup guide).",
    no_passcode: "No host passcode has been set yet. Set one in the Supabase SQL Editor (see the setup guide).",
    not_set_up: "The database isn't set up yet: run supabase/setup.sql in the Supabase SQL Editor.",
    network: "Can't reach the database. Check config.js and your connection."
  };

  function banner(msg) {
    $("banner").textContent = msg || "";
    $("banner").hidden = !msg;
  }

  /* ----------------------------------------------------------- network */

  // Call an admin function. Most answer with the whole console state.
  function call(fn, args) {
    args = args || {};
    args.p_token = token;
    return SC.rpc(fn, args).then(function (data) {
      if (data.game && data.teams) take(data);
      return data;
    }, function (err) {
      if (err.code === "unauthorised") {
        lockOut("Your session has ended. Sign in again.");
      } else {
        banner(ERRORS[err.code] || "Something went wrong (" + err.code + ").");
        if (err.code === "wrong_state") poll();
      }
      throw err;
    });
  }

  // Actions run one after another, in the order clicked, so none is lost.
  // An identical action already waiting (a double click) isn't sent twice.
  var actionQueue = Promise.resolve();
  var pending = {};
  function act(fn, args) {
    var key = fn + JSON.stringify(args || {});
    if (pending[key]) return pending[key];
    var run = actionQueue.then(function () { return call(fn, args); })
      .then(function (data) {
        banner("");
        return data;
      }, function () { return null; });
    actionQueue = run;
    pending[key] = run;
    run.then(function () { delete pending[key]; });
    return run;
  }

  function take(data) {
    latest = data;
    render();
  }

  function poll() {
    clearTimeout(pollTimer);
    if (!token) return;
    SC.rpc("sc_admin_state", { p_token: token })
      .then(function (data) {
        take(data);
        if ($("banner").textContent.indexOf("Retrying") >= 0) banner("");
      })
      .catch(function (err) {
        if (err.code === "unauthorised") return lockOut("Your session has ended. Sign in again.");
        banner((ERRORS[err.code] || "Lost touch with the database.") + " Retrying…");
      })
      .then(function () {
        if (token) pollTimer = setTimeout(poll, 2000);
      });
  }

  /* ------------------------------------------------------------- login */

  $("loginForm").onsubmit = function (e) {
    e.preventDefault();
    $("loginError").hidden = true;
    $("unlockBtn").disabled = true;
    SC.rpc("sc_admin_login", { p_passcode: $("passcode").value })
      .then(function (res) {
        token = res.token;
        SC.session.set("admin", token);
        $("passcode").value = "";
        openConsole();
      })
      .catch(function (err) {
        $("loginError").textContent = LOGIN_ERRORS[err.code] || "Something went wrong. Try again.";
        $("loginError").hidden = false;
        $("passcode").select();
      })
      .then(function () { $("unlockBtn").disabled = false; });
  };

  function openConsole() {
    show("console");
    $("playerLink").textContent = $("playerLink").href = SC.siteUrl("");
    $("scoreLink").textContent = $("scoreLink").href = SC.siteUrl("scoreboard.html");
    poll();
  }

  function lockOut(msg) {
    token = null;
    latest = null;
    tableSig = savedSig = "";
    SC.session.remove("admin");
    clearTimeout(pollTimer);
    $("stage").hidden = true;
    show("login");
    $("loginError").textContent = msg || "";
    $("loginError").hidden = !msg;
    $("passcode").focus();
  }

  $("logoutBtn").onclick = function () {
    var t = token;
    lockOut("");
    if (t) SC.rpc("sc_admin_logout", { p_token: t }).catch(function () {});
  };

  /* ------------------------------------------------------------ render */

  function phase(g) {
    if (g.status === "live" && g.timer && SC.timeLeft(g) === 0) return "up";
    return g.status;
  }

  var PILL = {
    lobby: "Lobby: teams can join",
    live: "Live",
    up: "Time's up",
    paused: "Paused",
    frozen: "Frozen"
  };

  function render() {
    if (!latest) return;
    renderControls();
    renderPhase();
    renderSummary();
    renderTable();
    renderSaved();
    if (latest.puzzle_count === 0) banner(ERRORS.no_puzzles);
  }

  function hhmm(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function when(ms) {
    return new Date(ms).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  // The pill, the big clock and the freeze button's emphasis: everything
  // that changes as the seconds tick.
  function renderPhase() {
    var g = latest.game;
    var ph = phase(g);
    var left = SC.timeLeft(g);

    $("statusPill").textContent = PILL[ph];
    $("statusPill").className = "pill " + ph;

    var label, text, note = "", small = false, low = false;
    if (g.status === "lobby") {
      var mins = parseFloat($("minutes").value);
      label = "Timer";
      if (mins > 0) { text = SC.clock(mins * 60000); } else { text = "No timer"; small = true; }
      note = latest.teams.length
        ? latest.teams.length + (latest.teams.length === 1 ? " team is" : " teams are") + " waiting. Start when everyone's in."
        : "Share the player link. Teams appear below as they join.";
    } else if (g.status === "frozen") {
      label = "Frozen";
      text = g.timer ? SC.clock(left) : "Stopped";
      small = !g.timer;
      note = latest.saved_at
        ? "Scores saved to the scoreboard at " + hhmm(latest.saved_at) + "."
        : "No teams played this round, so there was nothing to save.";
    } else if (!g.timer) {
      label = g.status === "paused" ? "Paused" : "No timer";
      text = g.status === "paused" ? "Paused" : "Live";
      small = true;
      note = g.status === "paused"
        ? "Guesses and joins are on hold. Resume to carry on."
        : "Freeze when you're ready to save the scores.";
    } else if (g.status === "paused") {
      label = "Paused";
      text = SC.clock(left);
      note = "The clock is stopped. Guesses and joins are on hold until you resume.";
    } else if (ph === "up") {
      label = "Time's up";
      text = SC.clock(0);
      note = g.lock_at_zero
        ? "Guesses have stopped. Freeze to save the scores."
        : "Teams can still play. Freeze when you're ready to save the scores.";
    } else {
      label = "Time left";
      text = SC.clock(left);
      low = left < 60000;
      note = "Ends at " + hhmm(g.timer.ends_at) + ".";
    }
    $("clockLabel").textContent = label;
    $("clock").textContent = text;
    $("clock").className = "clock" + (small ? " small" : "") + (low ? " low" : "");
    $("clockNote").textContent = note;

    var fb = $("freezeBtn");
    fb.className = "btn sm" + (ph === "up" ? " primary" : "");
  }

  function renderControls() {
    var g = latest.game;
    $("lobbyControls").hidden = g.status !== "lobby";
    $("liveControls").hidden = !(g.status === "live" || g.status === "paused");
    $("frozenControls").hidden = g.status !== "frozen";
    $("pauseBtn").textContent = g.status === "paused" ? "Resume" : "Pause";
    $("startBtn").disabled = latest.puzzle_count === 0;
    $("lockBox").checked = !!g.lock_at_zero;
    $("hintsBox").checked = !!g.hints_enabled;

    var label = $("roundLabel");
    label.placeholder = "Round " + g.round_no;
    if (document.activeElement !== label) label.value = g.label || "";

    if (g.status === "lobby" && !minutesTouched && document.activeElement !== $("minutes")) {
      $("minutes").value = latest.timer_default_s ? Math.round(latest.timer_default_s / 6) / 10 : 15;
    }
  }

  function renderSummary() {
    var teams = latest.teams;
    var done = teams.filter(function (t) { return t.finished; }).length;
    var playing = teams.filter(function (t) { return t.started && !t.finished; }).length;
    var lead = teams.length && teams[0].started ? teams[0] : null;
    $("sTeams").textContent = teams.length;
    $("sPlaying").textContent = playing;
    $("sDone").textContent = done;
    $("sTop").textContent = lead ? lead.name : "—";
    $("sUpdated").textContent = new Date().toLocaleTimeString();
  }

  function teamStatus(t, gameStatus) {
    if (t.finished) return "Finished";
    if (!t.started) return gameStatus === "lobby" ? "Joined" : "Not started";
    var n = (t.playing_idx === null || t.playing_idx === undefined) ? "" : " " + (t.playing_idx + 1);
    return gameStatus === "frozen" ? "Stopped on puzzle" + n : "Puzzle" + n;
  }

  function mistakes(n) { return n + " mistake" + (n === 1 ? "" : "s"); }

  // "2 mistakes" or "2 mistakes, 1 hint": what a puzzle cost a team.
  function costs(p, first) {
    var h = p.hints || 0;
    return first + (h ? ", " + h + (h === 1 ? " hint" : " hints") : "");
  }

  function renderTable() {
    var g = latest.game;
    var sig = JSON.stringify([g.status, latest.teams]);
    if (sig === tableSig) return;
    tableSig = sig;

    var box = $("tableBox");
    box.innerHTML = "";
    var teams = latest.teams;
    if (!teams.length) {
      box.appendChild(el("p", "empty", "No teams yet. Share the player link and they'll appear here."));
      return;
    }

    var table = el("table", "live");
    var hr = el("tr");
    hr.appendChild(el("th", "num", "#"));
    hr.appendChild(el("th", null, "Team"));
    hr.appendChild(el("th", null, "Status"));
    latest.puzzles.forEach(function (p, i) {
      var th = el("th", "num", "P" + (i + 1));
      th.title = p.name;
      hr.appendChild(th);
    });
    hr.appendChild(el("th", "num", "Points"));
    hr.appendChild(el("th", "num", "Time"));
    hr.appendChild(el("th", null, ""));
    var thead = el("thead");
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    teams.forEach(function (t) {
      var tr = el("tr");
      tr.appendChild(el("td", "num", t.rank));

      var nameCell = el("td");
      nameCell.appendChild(el("div", "tname", t.name));
      nameCell.appendChild(el("div", "tcode", t.code));
      tr.appendChild(nameCell);

      var status = teamStatus(t, g.status);
      var chipCls = t.finished ? "done" : (t.started && g.status !== "frozen" ? "live" : "");
      var sc = el("td");
      sc.appendChild(el("span", "chip " + chipCls, status));
      tr.appendChild(sc);

      t.puzzles.forEach(function (p) {
        var td = el("td", "num");
        var waiting = p.status === "locked" || g.status === "lobby";
        var d = el("div", "pcell" + (waiting ? " locked" : ""));
        if (waiting) {
          d.appendChild(el("b", null, "—"));
          d.appendChild(el("span", null, g.status === "lobby" ? "waiting" : "locked"));
        } else if (p.status === "playing") {
          d.appendChild(el("b", null, p.groups_found + "/4"));
          d.appendChild(el("span", null, costs(p, mistakes(p.mistakes))));
        } else {
          d.appendChild(el("b", null, p.points));
          d.appendChild(el("span", null, costs(p, p.status === "solved" ? mistakes(p.mistakes) : "not solved")));
        }
        td.appendChild(d);
        tr.appendChild(td);
      });

      var pts = el("td", "num");
      pts.appendChild(el("b", null, t.total_points + "/" + latest.max_points));
      tr.appendChild(pts);
      tr.appendChild(el("td", "num", SC.duration(t.total_time)));

      var act = el("td");
      var rm = el("button", "btn sm danger", "Remove");
      rm.type = "button";
      rm.onclick = function () { removeTeam(t); };
      act.appendChild(rm);
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    var wrap = el("div", "tablewrap");
    wrap.appendChild(table);
    box.appendChild(wrap);
  }

  function smallButton(text, onclick, extra) {
    var b = el("button", "btn sm" + (extra ? " " + extra : ""), text);
    b.type = "button";
    b.onclick = onclick;
    return b;
  }

  function renderSaved() {
    var sig = JSON.stringify(latest.results);
    if (sig === savedSig) return;
    savedSig = sig;

    var box = $("savedBox");
    box.innerHTML = "";
    if (!latest.results.length) {
      box.appendChild(el("p", "empty", "Nothing saved yet. Freeze a round to save its scores here."));
      return;
    }
    latest.results.forEach(function (r) {
      var row = el("div", "result");
      var info = el("div");
      var h = el("h3", null, r.label);
      h.appendChild(el("span", "chip" + (r.published ? " done" : ""), r.published ? "Published" : "Not published"));
      info.appendChild(h);
      var bits = ["Round " + r.round_no, "frozen " + when(r.frozen_at),
                  r.team_count + (r.team_count === 1 ? " team" : " teams")];
      if (r.winner) bits.push("winner: " + r.winner + " (" + r.winner_points + " pts)");
      info.appendChild(el("p", null, bits.join(" · ")));
      row.appendChild(info);

      var acts = el("div", "btnrow");
      acts.appendChild(smallButton("Present", function () { presentSaved(r.round_no); }));
      acts.appendChild(smallButton(r.published ? "Unpublish" : "Publish", function () {
        act("sc_admin_result_update", { p_round_no: r.round_no, p_published: !r.published });
      }));
      acts.appendChild(smallButton("Rename", function () {
        var name = window.prompt("New name for this scoreboard:", r.label);
        if (name && name.trim()) act("sc_admin_result_update", { p_round_no: r.round_no, p_label: name.trim() });
      }));
      acts.appendChild(smallButton("CSV", function () { exportSaved(r.round_no); }));
      acts.appendChild(smallButton("Delete", function () {
        if (window.confirm('Delete the saved scoreboard "' + r.label + '"?\n\nIt disappears from the scoreboard page too. This cannot be undone.')) {
          act("sc_admin_result_delete", { p_round_no: r.round_no });
        }
      }, "danger"));
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  // The clock ticks locally between polls.
  setInterval(function () {
    if (latest && !$("console").hidden) renderPhase();
  }, 250);

  /* ----------------------------------------------------------- actions */

  $("minutes").oninput = function () {
    minutesTouched = true;
    if (latest) renderPhase();
  };

  $("startBtn").onclick = function () {
    var mins = parseFloat($("minutes").value);
    if (isNaN(mins) || mins < 0) mins = 0;
    if (mins > 1440) return banner("A timer can run for up to 24 hours (1440 minutes).");
    if (mins > 0 && mins * 60 < 10) return banner("A timer needs at least 10 seconds.");
    act("sc_admin_start", { p_minutes: mins }).then(function (d) { if (d) minutesTouched = false; });
  };

  $("pauseBtn").onclick = function () {
    if (!latest) return;
    act(latest.game.status === "paused" ? "sc_admin_resume" : "sc_admin_pause");
  };

  $("addMinBtn").onclick = function () { act("sc_admin_add_time", { p_seconds: 60 }); };

  $("setTimeBtn").onclick = function () {
    if (!latest) return;
    var left = SC.timeLeft(latest.game);
    var current = left === null ? "" : String(Math.round(left / 6000) / 10);
    var typed = window.prompt("Set the time left, in minutes. Use 0 to remove the timer.", current);
    if (typed === null) return;
    var mins = parseFloat(typed.replace(",", "."));
    if (isNaN(mins) || mins < 0) return banner("That isn't a number of minutes.");
    var secs = Math.round(mins * 60);
    if (secs > 0 && secs < 10) return banner("A timer needs at least 10 seconds.");
    if (secs > 86400) return banner("A timer can run for up to 24 hours.");
    act("sc_admin_set_timer", { p_seconds: secs });
  };

  $("freezeBtn").onclick = function () {
    if (!latest) return;
    if (phase(latest.game) !== "up" && !window.confirm(
      "Freeze the game now?\n\nEveryone stops where they are and the scores are saved to the scoreboard. " +
      "You can unfreeze if you need to.")) return;
    act("sc_admin_freeze");
  };

  $("unfreezeBtn").onclick = function () {
    act("sc_admin_unfreeze").then(function (d) {
      if (d) banner("Unfrozen. The game is paused: press Resume to let teams carry on. Freezing again updates the saved scores.");
    });
  };

  function newRound() {
    if (!latest) return;
    var g = latest.game;
    var msg = "Start a new round?\n\nEvery team is cleared so a new group can play. Saved scoreboards are kept.";
    if (latest.teams.length && !latest.saved_at) {
      msg += "\n\nThis round hasn't been frozen, so its scores will NOT be saved.";
    } else if (latest.teams.length && g.status !== "frozen") {
      msg += "\n\nPlay since the last freeze will not be saved.";
    }
    if (!window.confirm(msg)) return;
    act("sc_admin_new_round", { p_label: "" }).then(function (d) {
      if (d) { minutesTouched = false; renderControls(); renderPhase(); }
    });
  }
  $("newRoundBtn").onclick = newRound;
  $("newRoundBtn2").onclick = newRound;

  $("lockBox").onchange = function () {
    act("sc_admin_set_lock", { p_lock: $("lockBox").checked });
  };

  $("hintsBox").onchange = function () {
    act("sc_admin_set_hints", { p_on: $("hintsBox").checked });
  };

  $("roundLabel").onchange = function () {
    act("sc_admin_set_label", { p_label: $("roundLabel").value });
  };
  $("roundLabel").onkeydown = function (e) {
    if (e.key === "Enter") { e.preventDefault(); $("roundLabel").blur(); }
  };

  function removeTeam(t) {
    if (!window.confirm('Remove "' + t.name + '"?\n\nTheir progress and score are deleted. If they still have the page open, they go back to the join screen.')) return;
    act("sc_admin_remove_team", { p_team_id: t.id });
  }

  $("resetBtn").onclick = function () {
    if (!window.confirm("Reset everything?\n\nThis deletes every team, every score and every saved scoreboard. It cannot be undone.")) return;
    var typed = window.prompt("To confirm, type RESET in capitals.");
    if (typed !== "RESET") return window.alert("Nothing was reset.");
    act("sc_admin_reset", { p_confirm: "RESET" }).then(function (d) {
      if (d) { minutesTouched = false; window.alert("Done. Every team and score has been cleared."); }
    });
  };

  $("copyLinkBtn").onclick = function () {
    var url = $("playerLink").href;
    var btn = $("copyLinkBtn");
    var done = function () {
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = "Copy"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt("Copy the player link:", url); });
    } else {
      window.prompt("Copy the player link:", url);
    }
  };

  /* ----------------------------------------------------------- exports */

  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // so Excel never runs a team name as a formula
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv(teams, puzzleNames, label, frozen) {
    var head = ["Rank", "Team", "Status"];
    puzzleNames.forEach(function (n, i) {
      head.push("P" + (i + 1) + " result", "P" + (i + 1) + " mistakes", "P" + (i + 1) + " hints",
                "P" + (i + 1) + " points");
    });
    head.push("Groups found", "Total points", "Total time (s)", "Total time");
    var lines = [head.map(csvCell).join(",")];
    teams.forEach(function (t) {
      var row = [t.rank, t.name, teamStatus(t, frozen ? "frozen" : "live")];
      t.puzzles.forEach(function (p) { row.push(p.status, p.mistakes, p.hints || 0, p.points); });
      row.push(t.groups_found, t.total_points,
               t.total_time === null ? "" : Number(t.total_time).toFixed(1),
               t.total_time === null ? "" : SC.duration(t.total_time));
      lines.push(row.map(csvCell).join(","));
    });

    var slug = String(label || "scores").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scores";
    var d = new Date();
    var stamp = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) +
                "-" + ("0" + d.getHours()).slice(-2) + ("0" + d.getMinutes()).slice(-2);
    var blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "simple-connections-" + slug + "-" + stamp + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  $("exportBtn").onclick = function () {
    if (!latest) return;
    var g = latest.game;
    downloadCsv(latest.teams, latest.puzzles.map(function (p) { return p.name; }),
                g.label || "round-" + g.round_no, g.status === "frozen");
  };

  function loadSaved(roundNo) {
    return call("sc_admin_results").then(function (data) {
      var r = data.rounds.filter(function (x) { return x.round_no === roundNo; })[0];
      if (!r) throw new Error("not_found");
      return r;
    });
  }

  function exportSaved(roundNo) {
    loadSaved(roundNo).then(function (r) {
      downloadCsv(r.teams, r.puzzle_names, r.label, true);
    }).catch(function () {});
  }

  /* ------------------------------------------------- presentation mode */

  $("presentBtn").onclick = function () {
    if (!latest) return;
    var g = latest.game;
    if (g.status === "frozen" && latest.saved_at) return presentSaved(g.round_no);
    present(latest.teams, g.label || "Round " + g.round_no, false);
  };

  function presentSaved(roundNo) {
    loadSaved(roundNo).then(function (r) {
      present(r.teams, r.label, true);
    }).catch(function () {});
  }

  // The ranking is captured when presentation mode opens, so it can't
  // shuffle under you while you talk.
  function present(teams, label, final) {
    stageTeams = teams.slice();
    revealed = 0;
    $("stageKicker").textContent = label;
    $("stageTitle").textContent = final ? "Final scores." : "Standings so far.";
    buildStage();
    $("stage").hidden = false;
    $("revealBtn").focus();
  }

  $("stageExit").onclick = function () { $("stage").hidden = true; };

  function buildStage() {
    var body = $("stageBody");
    body.innerHTML = "";
    if (!stageTeams.length) {
      body.appendChild(el("p", "empty", "No teams played."));
      $("revealBtn").disabled = true;
      $("stageHint").textContent = "";
      return;
    }
    stageTeams.forEach(function (t) {
      var row = el("div", "srow");
      row.appendChild(el("div", "rank", t.rank));
      row.appendChild(el("div", "nm", t.name));
      var bd = el("div", "bd");
      t.puzzles.forEach(function (p) {
        var sq = el("i");
        sq.setAttribute("data-p", String(p.points));
        sq.title = "Puzzle " + (p.idx + 1) + ": " + p.points + (p.points === 1 ? " point" : " points");
        bd.appendChild(sq);
      });
      row.appendChild(bd);
      row.appendChild(el("div", "pts", t.total_points));
      row.appendChild(el("div", "tm", SC.duration(t.total_time)));
      body.appendChild(row);
    });
    updateStage();
  }

  function ordinal(n) {
    var s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function updateStage() {
    var rows = $("stageBody").querySelectorAll(".srow");
    var n = rows.length;
    for (var i = 0; i < n; i++) {
      // rows[0] is first place, so reveal from the bottom up.
      var shown = i >= n - revealed;
      rows[i].classList.toggle("shown", shown);
      rows[i].classList.toggle("winner", shown && i === 0 && revealed === n);
    }
    var left = n - revealed;
    if (left > 0) {
      $("revealBtn").textContent = revealed === 0 ? "Reveal last place" :
        (left === 1 ? "Reveal the winner" : "Reveal " + ordinal(left));
      $("stageHint").textContent = left === 1
        ? "One to go."
        : left + " teams still hidden. Click Reveal, or press the space bar.";
      $("revealBtn").disabled = false;
    } else {
      $("revealBtn").textContent = "All revealed";
      $("revealBtn").disabled = true;
      $("stageHint").textContent = "Winner: " + stageTeams[0].name + " with " + stageTeams[0].total_points + " points.";
    }
  }

  $("revealBtn").onclick = function () {
    if (!stageTeams || revealed >= stageTeams.length) return;
    revealed++;
    updateStage();
  };

  document.addEventListener("keydown", function (e) {
    if ($("stage").hidden) return;
    if (e.key === " " || e.key === "ArrowRight" || e.key === "Enter") {
      e.preventDefault();
      $("revealBtn").click();
    } else if (e.key === "Escape") {
      $("stage").hidden = true;
    }
  });

  /* -------------------------------------------------------------- boot */

  if (!SC.configured()) {
    show("setup");
  } else if (token) {
    openConsole();
  } else {
    show("login");
    $("passcode").focus();
  }
})();
