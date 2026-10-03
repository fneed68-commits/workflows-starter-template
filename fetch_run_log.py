#!/usr/bin/env python3
import json
import sys
import urllib.request
import urllib.error

OWNER = "fneed68-commits"
REPO = "workflows-starter-template"
API = "https://api.github.com"

def get(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "log-fetcher/1.0",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def main():
    runs = get(f"{API}/repos/{OWNER}/{REPO}/actions/runs?per_page=5")
    if not runs.get("workflow_runs"):
        print("No workflow runs found.")
        return 1

    print("=== Latest runs ===")
    for r in runs["workflow_runs"]:
        print(f"  id={r['id']} status={r['status']} conclusion={r.get('conclusion')} created={r['created_at']}")
    print()

    latest = runs["workflow_runs"][0]
    if latest["status"] != "completed":
        print(f"Latest run not completed (status={latest['status']}). Try again later.")
        return 0

    print(f"=== Jobs in run {latest['id']} ===")
    jobs = get(f"{API}/repos/{OWNER}/{REPO}/actions/runs/{latest['id']}/jobs")
    for j in jobs.get("jobs", []):
        print(f"  job_id={j['id']} name={j['name']} status={j['status']} conclusion={j.get('conclusion')}")
        for step in j.get("steps", []):
            mark = "OK " if step.get("conclusion") == "success" else \
                   "FAIL" if step.get("conclusion") == "failure" else \
                   "run " if step.get("conclusion") is None else str(step.get("conclusion"))
            print(f"      [{mark}] {step['name']}")
    print()

    failed = next((j for j in jobs.get("jobs", []) if j.get("conclusion") == "failure"), None)
    if not failed:
        print("No failed job.")
        return 0

    print(f"=== Log for failed job: {failed['name']} ===")
    log_url = f"{API}/repos/{OWNER}/{REPO}/actions/jobs/{failed['id']}/logs"
    try:
        req = urllib.request.Request(log_url, headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "log-fetcher/1.0",
        })
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8", errors="replace")
        lines = text.splitlines()
        print(f"(total {len(lines)} lines; showing last 120)")
        print()
        for line in lines[-120:]:
            print(line)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.reason}")
        return 2

    return 0

if __name__ == "__main__":
    sys.exit(main())
