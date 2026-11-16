/* Simple connections - public scoreboard.
   Shows the rounds the host has frozen and chosen to publish. Names and
   scores only: no codes, no answers. Checks for updates every 20 seconds. */

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var el = SC.el;
  var rounds = [];
  var lastSig = "";

  function show(id) {
    ["setup", "empty", "main"].forEach(function (s) { $(s).hidden = s !== id; });
  }

  function load() {
    SC.rpc("sc_scoreboard")
      .then(function (data) {
        rounds = data.rounds || [];
        render();
      })
      .catch(function (err) {
        if (!rounds.length) {
          show("empty");
          $("emptyMsg").textContent = err.code === "not_set_up"
            ? "The game's database isn't set up yet."
            : "Can't reach the scoreboard right now. Retrying…";
        }
      })
      .then(function () { setTimeout(load, 20000); });
  }

  function chosenRound() {
    var m = window.location.hash.match(/round-(\d+)/);
    var wanted = m ? parseInt(m[1], 10) : null;
    return rounds.filter(function (r) { return r.round_no === wanted; })[0] || rounds[0];
  }

  function render() {
    var sig = JSON.stringify(rounds) + window.location.hash;
    if (sig === lastSig) return;
    lastSig = sig;

    if (!rounds.length) {
      $("rounds").hidden = true;
      show("empty");
      $("emptyMsg").textContent = "The host hasn't published any scores. They'll appear here as soon as they do: this page checks every 20 seconds.";
      return;
    }
    show("main");
    var r = chosenRound();

    var nav = $("rounds");
    nav.innerHTML = "";
    nav.hidden = rounds.length < 2;
    rounds.forEach(function (x) {
      var b = el("button", "tab", x.label);
      b.type = "button";
      b.setAttribute("aria-current", x === r ? "true" : "false");
      b.onclick = function () { window.location.hash = "round-" + x.round_no; };
      nav.appendChild(b);
    });

    var maxPoints = r.max_points;
    $("sbKicker").textContent = r.label;
    var saved = new Date(r.frozen_at).toLocaleString([], {
      weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit"
    });
    $("sbMeta").textContent = r.teams.length + (r.teams.length === 1 ? " team" : " teams") +
      " · saved " + saved;

    var box = $("sbTable");
    box.innerHTML = "";
    var list = el("ol", "sb");
    r.teams.forEach(function (t, i) {
      var li = el("li", "sbrow" + (i === 0 ? " first" : ""));
      li.appendChild(el("span", "rank", t.rank));
      li.appendChild(el("span", "nm", t.name));
      var bd = el("span", "bd");
      t.puzzles.forEach(function (p, k) {
        var sq = el("i");
        sq.setAttribute("data-p", String(p.points));
        sq.title = (r.puzzle_names[k] || "Puzzle " + (k + 1)) + ": " + p.points + (p.points === 1 ? " point" : " points");
        bd.appendChild(sq);
      });
      li.appendChild(bd);
      li.appendChild(el("span", "pts", t.total_points + "/" + maxPoints));
      li.appendChild(el("span", "tm", t.total_time === null ? "—" : SC.duration(t.total_time)));
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  window.addEventListener("hashchange", render);

  if (!SC.configured()) {
    show("setup");
  } else {
    load();
  }
})();
