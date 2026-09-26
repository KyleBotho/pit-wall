# Team Tracking: plan

Agreed with the user on 2026-09-26; to be built in a fresh session. Read CLAUDE.md first (architecture, conventions),
then this. The build order is below; check each phase's "done when" before moving on.

## Goal

Any signed-in user can follow their own F1 Fantasy teams without a data export: they join Pit Wall's tracking league
on F1 Fantasy, pick their F1 Fantasy username once, and from then on the Calculator and the other views load their
teams by themselves.

## Decisions (user, 2026-09-26)

- **The tracking league.** Each season the Fantasy Pit Wall (FPW) F1 account creates a private league. This season it
  is "Team Tracking" (its ID lives only in the private repo's `LEAGUE_IDS` secret; never write it into this repo). It
  is capped at 10 teams for now (the cap can be made unlimited later). It stays private: joining needs its code.
- **"ID" means the F1 Fantasy username**, e.g. "Fantasy Pit Wall" for the team "FPW Test Team 2". Users search by it;
  each result shows the username with its team names underneath, so duplicate team names don't confuse anyone.
- **No ownership check.** The tool only reads public data and can't change anything on F1 Fantasy, so seeing another
  username's teams does no harm. No code in the team name, no approval by the owner.
- **One username per account; any number of accounts may follow the same username** (nobody can block the owner by
  picking their username first). This also suits the future rivals feature.
- **Linked once.** After linking, the tool never asks again, unless the user deletes the link in Settings; then they
  do the setup again to keep using their teams.
- **A team updates only after the weekend's main race is done** (never before: that's also what F1 itself reveals).
- **Leaving:** a user can unlink or delete their data; members who leave the league stop being updated and their
  stored data goes after the season.
- **Google sign-in stays in testing mode** (only test users can sign in) until the tool is published.
- **Two phases** for seeing members (below): public data first, then the FPW account.

## How it works

1. The user signs in with Google. With no link yet, the site shows the setup:
   a. "Join Pit Wall's tracking league on F1 Fantasy with **all** your teams" plus the league's join code. The code is
      read from Supabase and shown only to signed-in users (never in the public page source).
   b. "I've joined" -> a search box: type your F1 Fantasy username. Results: username, team names underneath.
   c. Pick yours -> linked. The Calculator fills in your teams (names, line-ups, bank, free transfers, chips).
2. From then on each sign-in loads the linked teams; after each race the private workflow adds the round and
   `applyTracked()` moves each team on, as it does for the owner's teams today.
3. Settings shows "Your F1 Fantasy account: <username> (team names)" with **Change** and **Delete**.

If a new member isn't in the data yet (phase A: they joined after the last leaderboard update), the search says so:
"New members appear after the next race's standings update" (phase B removes this wait).

## Data (Supabase; add to `supabase/setup.sql`, re-runnable)

Store no raw F1 ids: link by an **account key** = first 16 hex of SHA-256("<user_guid>"), like `f1feeds.team_key` for
teams (add `f1feeds.account_key` and a matching page helper next to `teamTk`, with one shared test vector). The
username is stored because it is what users search for; users opted in by joining the league.

- `tracked_accounts` (one row per F1 account in a tracking league), written only by the private workflow:
  `account_key text primary key`, `username text`, `teams jsonb` ([{tk, no, name}]), `body jsonb` (that account's
  teams' history in the league-payload shape: `names`, `rounds`, `seen`, keyed by team key), `league text`,
  `updated_at timestamptz`. RLS: `select` to `authenticated` (search and loading); no writes from the page.
- `account_links` (one row per Pit Wall account): `user_id uuid primary key references auth.users on delete
  cascade`, `account_key text not null`, `linked_at timestamptz default now()`. RLS: each user can select, insert,
  update and delete only their own row. **Not** unique on `account_key` (any number of accounts may follow one).
- `app_config` (key/value, e.g. `tracking_join_code`): `select` to `authenticated` only.
- Keep `league_data` + `league_readers` as they are: the owner's own private leagues (Windhonne etc.) stay visible
  only to readers. Joining the tracking league must not reveal them.
- Search: `tracked_accounts` filtered with `ilike` on `username`, limit ~20 (a trigram index isn't needed at this size).

## Phase A: public data (no FPW session needed)

The public private-league standings feed (`leaderboard/privateleague/list_1_<id>_0_1.json`, used by `leagues.py`)
already lists every member's `user_name`, `user_guid`, `team_no`, `team_name` and, after each race, `user_team` (the
line-up that scored). It updates after each race (a brand-new league 403s until first published).

Private repo (`../pit-wall-private`):
1. Mark which `LEAGUE_IDS` entry is the tracking league (e.g. a third field `<id>:<Name>:track`), so the code knows.
2. In `leagues.py`, keep `user_name` for the tracking league only (other leagues still drop manager names); build
   one `tracked_accounts` row per account from the snapshots (`round_table`'s logic per account: points per round,
   the line-up seen after each round), and upsert changed rows with the secret key (as `publish_to_account` does;
   its own "changed?" state). A round's line-up is written only once that round's race has started (it only shows
   in the feed after the race anyway).
3. Remove accounts no longer in the league from the next season's data (keep this season's for history).

Page (this repo):
4. `web/js/sync.js`: after sign-in, read `account_links`; none -> open the setup (join code, search, pick). With a
   link, load that account's `tracked_accounts` row and use it like the league payload for the user's teams:
   `state.teams[i]` get `tk` and names from `teams`, then `fillFromLineups` / `applyTracked` / `tracked()` as today.
   Generalise the existing `LEAGUE_DATA` path rather than adding a parallel one (`tracked()` reads `rounds`, `seen`,
   `lineups` by team key; merge the linked account's body into what it reads).
5. Settings: the linked username + teams, Change (search again) and Delete (removes the row, clears the teams back to
   the example, shows the setup next time).
6. Deleting the Pit Wall account (auth user) cascades the link.

Done when: a test user (Google test list) signs in with no link, sees the setup with the join code, finds "Fantasy
Pit Wall" by typing part of it, sees its team names, links it; the Calculator shows those teams; a reload doesn't ask
again; Delete brings the setup back; the owner's private leagues stay hidden from a user who isn't a reader.
Tests: account-key vector (Python + page), `tracked_accounts` builder from snapshot fixtures, page setup state logic.

## Phase B: the FPW account (members visible before their first race)

The FPW team sits in the tracking league, so the logged-in site shows members and team names as soon as they join.
The public feed doesn't until the next race. Phase B reads what the FPW account sees.

Prerequisites (both with the user):
- **The endpoint.** In the in-app browser the user signs in to the FPW account themselves and opens the tracking
  league; read the network requests and note only the endpoint that lists the members (and, if present, the
  per-team endpoint used for rivals, `services/user/opponentteam/opponentgamedayplayerteamget/...`). Don't study how
  the site logs in or renews its session (earlier sessions agreed not to pursue that).
- **Session lifetime.** The private repo's daily `session_check.py` logs to `history/session-check.csv` since
  2026-09-25. Read it around 2026-10-09 (earlier if a run fails). If a session lasts weeks, a manual refresh now and
  then is fine; if it lasts a day, phase B needs a rethink with the user.

Build (private repo only): a member-list call with the session cookie secrets (`F1_SESSION_COOKIE`, as
`session_check.py` uses them) in the leagues workflow, paced like every other feed (one call per run, stop on the
first 401/403/429, never retry into a block). It adds new members' `username` + `teams` to `tracked_accounts` (no
line-ups until after their first race). On a 401 the run carries on with public data and the session check flags the
expiry; the user signs in and updates the secret.

Security of the FPW account (agreed): no payment details, a unique password, two-factor login if F1 offers it. Its
cookies live only in the private repo's secrets and are used only by the private workflow: never in Supabase, the
page or anyone's browser. **The login itself is not automated** (see "Why not automate the login" below).

Done when: a member who joined the league after the last race can be found and linked before the next race.

## Later: rivals

Compare your teams with chosen rivals from the tracking league (any `tracked_accounts` row) or the global top 500
(`data/elite_top100.json` / elite history). The Calculator's "rival" start team and goal already take a rival's
line-up; rivals would come from these sources instead of only imported/sealed leagues.

## Why not automate the login

- F1's login is protected against bots. Scripting it means getting past that protection, which Claude won't do,
  and which is how accounts get banned.
- The workflow would have to hold the FPW **password** instead of a session cookie. A password gives full control of
  the account (it can change the password and email); a cookie expires by itself and is revoked by signing out.
- It raises the stakes under F1's terms on automated access; reading with a session a person started keeps the
  footprint small.

So: the user signs in by hand when the session check reports an expired session, and updates the secret.

## Open questions (ask the user when building)

1. Does a signed-in user **have** to finish the setup before using the tool, or is it only needed for their own
   teams (anonymous visitors keep the example-team view either way)?
2. F1 usernames may not be unique and can change: the link uses the account key, so this only affects search. Show
   the team names (and the league's current points) in results so two identical usernames can be told apart.
3. Next season: a new tracking league. Links carry over (they're by account, not league); users re-join the new
   league with their teams.
