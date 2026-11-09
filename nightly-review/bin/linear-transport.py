#!/usr/bin/env python3
"""Linear transport for nightly-review: GraphQL reads, policy-CLI writes.

Same command contract as the policy CLI (`call <tool> --arguments JSON [--publish]`).
Each Linear MCP tool call costs several requests of the shared 2,500/hour quota
because every process opens a new MCP session; a complete project inventory made
that way exceeds the quota for the main project. Reads therefore use one GraphQL
request per call and keep the MCP output shape the writer already consumes.
Writes are delegated unchanged to ~/.gjc/agent/policy/bin/linear-trace.py, which
owns write auditing and the 429 -> Aside rule.

Credentials: the same owner-only, single-link ~/.gjc/agent/mcp.json bearer key is
parsed in-process and sent only to the fixed Linear GraphQL endpoint. It is never
printed, logged or passed as an argument. Errors are reduced to fixed messages.
"""
import json
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENDPOINT = "https://api.linear.app/graphql"
MCP_ENDPOINT = "https://mcp.linear.app/mcp"
POLICY_CLI = Path.home() / ".gjc/agent/policy/bin/linear-trace.py"
READS = {"get_issue", "list_issues", "list_comments", "list_issue_labels"}
WRITES = {"save_issue", "save_comment"}
QUOTA_HINT = ("Linear 요청 한도 소진(429) — 차단이 아니다. 같은 세션에서 Aside로 계속한다: "
              "python3 ~/.gjc/agent/policy/bin/linear-aside.py read|search|comment|status|create "
              "(rule://linear-work 「한도 소진」). (Linear rate limit — switch to linear-aside.py)")

ISSUE_FIELDS = """id identifier title description priority priorityLabel url createdAt updatedAt archivedAt triagedAt
  state { name type } labels(first: 50) { nodes { id name } pageInfo { hasNextPage } }
  assignee { id name } delegate { id name } project { id name } parent { id }
  relations(first: 50) { nodes { type relatedIssue { id identifier } } pageInfo { hasNextPage } }"""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("redirect refused; credential stays on the Linear endpoint")


def credential(config=None):
    p = Path(config or Path.home() / ".gjc/agent/mcp.json")
    st = p.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) & 0o077:
        raise ValueError("MCP config must be a single-link regular file with owner-only permissions")
    c = json.loads(p.read_text())["mcpServers"]["linear"]
    if c.get("url") != MCP_ENDPOINT or c.get("type") != "http":
        raise ValueError("Expected the official Linear configuration")
    auth = c.get("headers", {}).get("Authorization", "")
    if not auth.startswith("Bearer lin_api_"):
        raise ValueError("Expected a configured Linear API-key bearer credential")
    return auth[len("Bearer "):]


def graphql(query, variables, key, opener=None):
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, headers={"Authorization": key, "Content-Type": "application/json"})
    try:
        with (opener or urllib.request.build_opener(NoRedirect())).open(req, timeout=30) as response:
            raw = response.read(8_000_001)
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RuntimeError(QUOTA_HINT) from None
        raise RuntimeError(f"Linear GraphQL HTTP {exc.code}; no automatic retry") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Linear GraphQL connection failed; no automatic retry") from None
    if len(raw) > 8_000_000:
        raise RuntimeError("Linear GraphQL response too large; refusing partial evidence")
    data = json.loads(raw)
    errors = data.get("errors") or []
    if any((e.get("extensions") or {}).get("code") == "RATELIMITED" for e in errors if isinstance(e, dict)):
        raise RuntimeError(QUOTA_HINT)
    if errors or not isinstance(data.get("data"), dict):
        raise RuntimeError("Linear GraphQL query error; no automatic retry")
    return data["data"]


def complete(connection, what):
    if connection["pageInfo"]["hasNextPage"]:
        raise RuntimeError(f"{what} exceed one page; refusing partial evidence")
    return connection["nodes"]


PRIORITY = {0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}


def map_issue(node):
    """GraphQL issue -> the policy-CLI get_issue shape consumed by lib/linear.mjs."""
    if not node:
        raise RuntimeError("Linear issue not found")
    duplicate = [r["relatedIssue"] for r in complete(node["relations"], "relations") if r["type"] == "duplicate" and r.get("relatedIssue")]
    priority = int(node["priority"] or 0)
    issue = {
        "id": node["identifier"], "uuid": node["id"], "title": node["title"],
        "description": node["description"] or "",
        "priority": {"value": priority, "name": node.get("priorityLabel") or PRIORITY.get(priority, str(priority))},
        "url": node["url"], "createdAt": node["createdAt"], "updatedAt": node["updatedAt"],
        "archivedAt": node["archivedAt"], "triagedAt": node["triagedAt"],
        "status": node["state"]["name"], "statusType": node["state"]["type"],
        "labels": [label["name"] for label in complete(node["labels"], "labels")],
        "assignee": (node["assignee"] or {}).get("name"), "assigneeId": (node["assignee"] or {}).get("id"),
        "delegate": (node["delegate"] or {}).get("name"), "delegateId": (node["delegate"] or {}).get("id"),
        "project": (node["project"] or {}).get("name"), "projectId": (node["project"] or {}).get("id"),
        "parentId": (node["parent"] or {}).get("id"),
    }
    if len(duplicate) > 1:
        raise RuntimeError("multiple duplicate relations; refusing ambiguous evidence")
    if duplicate:
        issue["duplicateOf"] = {"uuid": duplicate[0]["id"], "id": duplicate[0]["identifier"]}
    return issue


def page_args(args, default):
    limit = int(args.get("limit", default))
    if not 1 <= limit <= 100:
        raise ValueError("limit must be 1..100")
    return limit, args.get("cursor")


def read(tool, args, query):
    if tool == "get_issue":
        data = query(f"query($id: String!) {{ issue(id: $id) {{ {ISSUE_FIELDS} }} }}", {"id": str(args["id"])})
        return map_issue(data["issue"])
    if tool == "list_issues":
        limit, cursor = page_args(args, 100)
        data = query("""query($n: Int!, $after: String, $project: String!) {
          issues(first: $n, after: $after, includeArchived: true, filter: { project: { name: { eq: $project } } }) {
            nodes { id identifier } pageInfo { hasNextPage endCursor } } }""", {"n": limit, "after": cursor, "project": str(args["project"])})
        page = data["issues"]
        return {"issues": [{"id": n["id"], "identifier": n["identifier"]} for n in page["nodes"]],
                "hasNextPage": page["pageInfo"]["hasNextPage"], "cursor": page["pageInfo"]["endCursor"]}
    if tool == "list_comments":
        limit, cursor = page_args(args, 50)
        data = query("""query($id: String!, $n: Int!, $after: String) { issue(id: $id) {
          comments(first: $n, after: $after) { nodes { id body createdAt updatedAt } pageInfo { hasNextPage endCursor } } } }""",
                     {"id": str(args["issueId"]), "n": limit, "after": cursor})
        if not data["issue"]:
            raise RuntimeError("Linear issue not found")
        page = data["issue"]["comments"]
        return {"comments": page["nodes"], "hasNextPage": page["pageInfo"]["hasNextPage"], "cursor": page["pageInfo"]["endCursor"]}
    if tool == "list_issue_labels":
        limit, _ = page_args(args, 100)
        data = query("""query($n: Int!, $name: String!) { issueLabels(first: $n, filter: { name: { eq: $name } }) {
          nodes { id name team { name } } pageInfo { hasNextPage } } }""", {"n": limit, "name": str(args["name"])})
        team = args.get("team")
        labels = [{"id": n["id"], "name": n["name"]} for n in data["issueLabels"]["nodes"] if n["team"] is None or n["team"]["name"] == team]
        return {"labels": labels, "hasNextPage": data["issueLabels"]["pageInfo"]["hasNextPage"]}
    raise ValueError("unsupported read tool")


def main(argv):
    if len(argv) < 4 or argv[0] != "call" or "--arguments" not in argv:
        print("usage: linear-transport.py call <tool> --arguments JSON [--publish]", file=sys.stderr)
        return 2
    tool = argv[1]
    if tool in WRITES:
        # Writes keep the audited policy path, including its write gate and quota rule.
        return subprocess.run([sys.executable, str(POLICY_CLI), *argv], check=False).returncode
    if tool not in READS or "--publish" in argv:
        print("linear-transport: unsupported tool", file=sys.stderr)
        return 2
    try:
        args = json.loads(argv[argv.index("--arguments") + 1])
        key = credential()
        result = read(tool, args, lambda q, v: graphql(q, v, key))
    except (ValueError, RuntimeError, KeyError, TypeError, OSError, json.JSONDecodeError) as exc:
        print("linear-transport: " + (str(exc) if isinstance(exc, (ValueError, RuntimeError)) else "invalid input or configuration"), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
