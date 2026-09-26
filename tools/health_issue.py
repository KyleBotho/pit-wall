"""Keep one "Data health" issue in this repo in step with build/health.json (health.py): opened when something is
listed, a comment when something new is listed (GitHub emails the repo's watchers on new issues and comments), closed
when all is clear. Run by refresh.yml's health job with the job's GITHUB_TOKEN (issues: write).

    HEALTH=<health.json contents> GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo python tools/health_issue.py
"""

import contextlib
import json
import os
import re
import sys
import urllib.error
import urllib.request

LABEL = "data-health"
ICON = {"error": "🔴", "warn": "🟠", "notice": "🔵"}
MARK = re.compile(r"<!-- health:(\[.*?\]) -->")


def render(items, site="https://kylebotho.github.io/pit-wall/"):
    """-> (title, body) for the issue. The ids listed are kept in a hidden marker to tell what changed."""
    probs = [i for i in items if i["level"] != "notice"]
    notes = [i for i in items if i["level"] == "notice"]
    title = "Data health: " + ", ".join(
        x
        for x in (
            f"{len(probs)} problem{'s' * (len(probs) != 1)}" if probs else "",
            f"{len(notes)} notice{'s' * (len(notes) != 1)}" if notes else "",
        )
        if x
    )
    line = lambda i: f"- {ICON.get(i['level'], '-')} {i['msg']} _(since {i['since'].replace('T', ' ')[:16]} UTC)_"  # noqa: E731
    parts = []
    if probs:
        parts += ["**Problems** (listed until fixed)", *map(line, probs), ""]
    if notes:
        parts += ["**Notices** (changes worth a look; shown for 3 days)", *map(line, notes), ""]
    parts += [
        f"Updated by the refresh workflow; it closes this issue when all is clear. Details in the site's Settings > "
        f"Admin > Data health ({site}).",
        f"<!-- health:{json.dumps(sorted(i['id'] for i in items))} -->",
    ]
    return title, "\n".join(parts)


def listed(body):
    m = MARK.search(body or "")
    return json.loads(m.group(1)) if m else []


def change_note(items, old_ids):
    """The comment for a changed list: what's new and what cleared."""
    new = [i for i in items if i["id"] not in old_ids]
    gone = [x for x in old_ids if x not in {i["id"] for i in items}]
    out = []
    if new:
        out += ["New:", *(f"- {ICON.get(i['level'], '-')} {i['msg']}" for i in new)]
    if gone:
        out += [f"Cleared: {len(gone)} item{'s' * (len(gone) != 1)}."]
    return "\n".join(out)


def api(method, path, body=None):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def main():
    items = json.loads(os.environ.get("HEALTH") or "{}").get("items") or []
    open_ = api("GET", f"/issues?labels={LABEL}&state=open&per_page=5") or []
    issue = open_[0] if open_ else None
    if not items:
        if issue:
            api("POST", f"/issues/{issue['number']}/comments", {"body": "All clear."})
            api("PATCH", f"/issues/{issue['number']}", {"state": "closed", "state_reason": "completed"})
            print(f"closed #{issue['number']}")
        return
    title, body = render(items)
    if not issue:
        with contextlib.suppress(urllib.error.HTTPError):  # the label may be there already
            api("POST", "/labels", {"name": LABEL, "color": "d93f0b", "description": "Opened by the refresh workflow"})
        n = api("POST", "/issues", {"title": title, "body": body, "labels": [LABEL]})["number"]
        print(f"opened #{n}")
        return
    old = listed(issue.get("body"))
    if old == sorted(i["id"] for i in items):
        print(f"#{issue['number']} unchanged")
        return
    api("PATCH", f"/issues/{issue['number']}", {"title": title, "body": body})
    if any(i["id"] not in old for i in items):  # a comment (an email) only for something new, not for what cleared
        api("POST", f"/issues/{issue['number']}/comments", {"body": change_note(items, old)})
    print(f"updated #{issue['number']}")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:  # never fail the workflow over the issue
        print(f"::warning::health issue not updated: {e.code} {e.read()[:200]!r}")
        sys.exit(0)
