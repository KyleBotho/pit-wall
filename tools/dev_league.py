"""The signed-in league data for the LOCAL preview only (web/js/sync.js devLeague, http://localhost:8765/?league).

Rebuilds the league payload (as the private repo's leagues.py uploads it) and the linked account's tracked_accounts
row from the private clone's saved snapshots (../pit-wall-private, or PIT_WALL_PRIVATE), and writes them to
build/dev-league.json. No league feed is fetched (only the public schedule, for the round locks) and nothing is sent
anywhere. build/ is gitignored and CI builds its own, so the file is never committed or deployed: it holds private
league data, keep it that way.

    python tools/dev_league.py
"""

import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRIV = os.environ.get("PIT_WALL_PRIVATE") or os.path.join(HERE, "..", "pit-wall-private")
OUT = os.path.join(HERE, "build", "dev-league.json")


def main():
    if not os.path.exists(os.path.join(PRIV, "leagues.py")):
        sys.exit(f"No private clone at {PRIV}")
    sys.path.insert(0, PRIV)
    import leagues as L  # the private repo's own code, so the payload matches what it uploads

    locks = L.round_locks()
    bfp = os.path.join(PRIV, "history", "backfill.json")
    bf = L.load(bfp) if os.path.exists(bfp) else {}
    latest = []  # each league's latest snapshot
    for d in sorted(glob.glob(os.path.join(PRIV, "history", "[0-9]*"))):
        files = sorted(glob.glob(os.path.join(d, "*.json")), key=os.path.basename)
        if files:
            latest.append(L.load(files[-1]))
    names, key_of = L.team_names(latest, bf)
    rounds, seen = L.round_table(locks, bf, key_of)
    lineups, rivals = ({key_of({"team": t}): v for t, v in bf.get(k, {}).items()} for k in ("lineups", "rivals"))
    payload = {
        "v": 2,
        "leagues": [
            {**x, "members": [{k: v for k, v in m.items() if k not in L.PRIVATE_FIELDS} for m in x["members"]]}
            for x in latest
        ],
        "names": names,
        "rounds": rounds,
        "lineups": lineups,
        "rivals": rivals,
        "seen": seen,
    }
    # the linked account: the tracking-league account that owns the export's own teams
    account = None
    track = next((x for x in latest if any(m.get("ak") for m in x["members"])), None)
    if track:
        snaps = [s for s in (L.load(p) for p in L.snapshots()) if s.get("name") == track["name"]]
        for row in L.tracked_accounts(snaps, locks, track["name"]):
            if set(lineups) & {t["tk"] for t in row["teams"]}:
                account = {k: row[k] for k in ("account_key", "username", "teams", "body")}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"league": payload, "account": account}, f, ensure_ascii=False)
    print(f"{OUT}: {len(latest)} leagues, account {'found' if account else 'not found'}")


if __name__ == "__main__":
    main()
