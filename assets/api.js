/* Simple connections - the link to the game's database.

   The game runs on Supabase. Every call is
       POST <supabaseUrl>/rest/v1/rpc/<function>   with a JSON body
   to one of the sc_* functions in supabase/setup.sql. Each answers
   {"ok": true, ...} or {"ok": false, "error": "<code>"}; this file turns the
   second shape (and network trouble) into a rejected promise whose
   error.code says what went wrong.

   Also here: the shared clock (so every screen counts down together) and
   a few small formatting helpers. */

(function () {
  "use strict";

  var cfg = window.SC_CONFIG || {};

  function configured() {
    if (typeof cfg.rpc === "function") return true;   // local test harness
    var url = String(cfg.supabaseUrl || "");
    var key = String(cfg.supabaseKey || "");
    return /^https:\/\/\S+$/.test(url) && !/YOUR-PROJECT/i.test(url) &&
           key.length > 20 && !/^YOUR-/i.test(key);
  }

  function failure(code, status) {
    var e = new Error(code);
    e.code = code;
    e.status = status || 0;
    return e;
  }

  /* ------------------------------------------------------------ clock */

  // Every answer carries server_now. Comparing it with this machine's clock
  // (allowing for the round trip) gives the offset to the server's time.
  var offset = 0;
  var bestRtt = Infinity;

  function noteServerTime(serverNow, sentAt, gotAt) {
    if (typeof serverNow !== "number") return;
    var rtt = Math.max(0, gotAt - sentAt);
    bestRtt += 25;   // slowly forget, so a changed clock is picked up again
    if (rtt <= bestRtt) {
      bestRtt = rtt;
      offset = serverNow - (sentAt + rtt / 2);
    }
  }

  function now() { return Date.now() + offset; }

  // Milliseconds left on a game's timer, or null when there's no timer.
  function timeLeft(game) {
    var t = game && game.timer;
    if (!t) return null;
    if (t.running) return Math.max(0, t.ends_at - now());
    return Math.max(0, t.left_ms || 0);
  }

  /* -------------------------------------------------------------- rpc */

  function rpc(fn, args) {
    if (!configured()) return Promise.reject(failure("not_configured"));
    var sentAt = Date.now();
    var call;

    if (typeof cfg.rpc === "function") {
      call = Promise.resolve()
        .then(function () { return cfg.rpc(fn, args || {}); })
        .catch(function (e) {
          throw failure(e && e.status === 404 ? "not_set_up" : "server_error", e && e.status);
        });
    } else {
      var headers = { "Content-Type": "application/json", "apikey": cfg.supabaseKey };
      // A legacy "anon" key is a JWT and also goes in Authorization. The newer
      // publishable keys (sb_publishable_...) must not.
      if (/^eyJ/.test(cfg.supabaseKey)) headers.Authorization = "Bearer " + cfg.supabaseKey;
      call = fetch(String(cfg.supabaseUrl).replace(/\/+$/, "") + "/rest/v1/rpc/" + fn, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(args || {}),
        cache: "no-store"
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (data) {
          // 404 = the function isn't there: setup.sql hasn't been run.
          if (!r.ok) throw failure(r.status === 404 ? "not_set_up" : "server_error", r.status);
          return data;
        });
      }, function () {
        throw failure("network");
      });
    }

    return call.then(function (data) {
      if (!data || typeof data !== "object") throw failure("bad_response");
      noteServerTime(data.server_now, sentAt, Date.now());
      if (data.state && typeof data.state.server_now === "number") {
        noteServerTime(data.state.server_now, sentAt, Date.now());
      }
      if (data.ok === false) {
        var e = failure(data.error || "failed");
        e.data = data;
        throw e;
      }
      return data;
    });
  }

  /* ---------------------------------------------------------- storage */

  // Namespaced so the local test arena can run two teams in one browser.
  var ns = "simple-connections:" + (cfg.storageNamespace ? cfg.storageNamespace + ":" : "");

  function store(kind) {
    return {
      get: function (k) { try { return window[kind].getItem(ns + k) || ""; } catch (e) { return ""; } },
      set: function (k, v) { try { window[kind].setItem(ns + k, v); } catch (e) {} },
      remove: function (k) { try { window[kind].removeItem(ns + k); } catch (e) {} }
    };
  }

  /* ---------------------------------------------------------- helpers */

  function clock(ms) {
    if (ms === null || ms === undefined) return "—";
    var s = Math.ceil(Math.max(0, ms) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ":" + ("0" + m).slice(-2) : String(m)) + ":" + ("0" + sec).slice(-2);
  }

  function duration(secs) {
    if (secs === null || secs === undefined) return "—";
    var s = Math.round(secs);
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }

  var WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
               "eleven", "twelve"];
  function numberWord(n) { return WORDS[n] || String(n); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function siteUrl(page) {
    var here = window.location.href.split("#")[0].split("?")[0];
    return here.replace(/[^\/]*$/, "") + (page || "");
  }

  window.SC = {
    configured: configured,
    rpc: rpc,
    now: now,
    timeLeft: timeLeft,
    local: store("localStorage"),
    session: store("sessionStorage"),
    clock: clock,
    duration: duration,
    numberWord: numberWord,
    el: el,
    siteUrl: siteUrl
  };
})();
