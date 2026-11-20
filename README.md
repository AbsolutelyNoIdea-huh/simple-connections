# Simple connections

A Connections-style team game for Aion Silicon's Values Month.

- `index.html`: the game. Teams join, wait in the lobby, then find four
  groups of four in each themed puzzle.
- `admin.html`: the host console. Live scores, the countdown, pause, freeze
  and save, presentation mode. Needs the host passcode.
- `scoreboard.html`: scoreboards the host has published.
- `how-to-play.html`: the rules and the scoring, with a practice puzzle
  that runs in the browser and never counts. Its words are made up for
  practice and aren't in the real game.

This is a static site. The game state, the scoring and the puzzles live in a
Supabase database; `config.js` says which one. The key in `config.js` is a
public key: it can only call the game's own functions.
