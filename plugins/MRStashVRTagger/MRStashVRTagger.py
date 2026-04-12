import sys
import json
import os
import urllib.request
import urllib.error
import time

PLUGIN_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
ASSETS_DIR = os.path.join(PLUGIN_DIR, "assets")
SESSION_COOKIE = None


def graphql_query(url, apikey, query, variables=None):
    headers = {"Content-Type": "application/json"}
    if apikey:
        headers["ApiKey"] = apikey
    elif SESSION_COOKIE:
        headers["Cookie"] = SESSION_COOKIE
    data = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as response:
            body = json.loads(response.read().decode("utf-8"))
            if "errors" in body:
                print(f"GraphQL errors: {body['errors']}", flush=True)
            return body
    except urllib.error.URLError as e:
        print(f"GraphQL request failed: {e}", flush=True)
        sys.exit(1)


def find_or_create_vr_tag(url, apikey, tag_name):
    res = graphql_query(url, apikey, """
    query FindTags($name: String!) {
      findTags(filter: {q: $name}) { tags { id name } }
    }
    """, {"name": tag_name})
    tags = res.get("data", {}).get("findTags", {}).get("tags", [])
    for t in tags:
        if t["name"].lower() == tag_name.lower():
            return t["id"]
    return None


def fetch_all_scenes(url, apikey):
    """Paginate through every scene."""
    all_scenes = []
    page = 1
    per_page = 200
    while True:
        res = graphql_query(url, apikey, """
        query AllScenes($page: Int!, $per_page: Int!) {
          findScenes(filter: {page: $page, per_page: $per_page}) {
            count
            scenes {
              id
              title
              paths { screenshot }
              tags { id name }
              files { width height duration }
            }
          }
        }
        """, {"page": page, "per_page": per_page})
        data = res.get("data", {}).get("findScenes", {})
        scenes = data.get("scenes", [])
        if not scenes:
            break
        all_scenes.extend(scenes)
        total = data.get("count", 0)
        print(f"Fetched {len(all_scenes)}/{total} scenes…", flush=True)
        if len(all_scenes) >= total:
            break
        page += 1
    return all_scenes


def task_audit_vr_tags(url, apikey, plugins_config):
    cfg = plugins_config.get("MRStashVRTagger", {}) or {}
    tag_name = (cfg.get("vr_tag_name") or "Virtual Reality").strip()
    try:
        threshold = float(cfg.get("vr_aspect_ratio") or "1.9")
    except ValueError:
        threshold = 1.9

    print(f"VR tag: {tag_name!r}  threshold: {threshold}", flush=True)

    vr_tag_id = find_or_create_vr_tag(url, apikey, tag_name)
    if not vr_tag_id:
        print(f"Warning: Tag {tag_name!r} not found in library. "
              f"Scenes flagged for ADD won't have a tag to apply until you create it.", flush=True)

    scenes = fetch_all_scenes(url, apikey)
    print(f"Auditing {len(scenes)} scenes…", flush=True)

    needs_add = []      # wide enough, but no VR tag
    needs_remove = []   # has VR tag, but not wide enough
    skipped = []        # no file / no dimensions

    for scene in scenes:
        files = scene.get("files") or []
        if not files:
            skipped.append({"id": scene["id"], "title": scene.get("title"), "reason": "no files"})
            continue
        f = files[0]
        w, h = f.get("width") or 0, f.get("height") or 0
        if not w or not h:
            skipped.append({"id": scene["id"], "title": scene.get("title"), "reason": "no dimensions"})
            continue

        ratio = w / h
        is_wide = ratio >= threshold
        tags = scene.get("tags") or []
        has_vr = any(
            (vr_tag_id and t["id"] == vr_tag_id) or t["name"].lower() == tag_name.lower()
            for t in tags
        )

        entry = {
            "id": scene["id"],
            "title": scene.get("title") or f"Scene #{scene['id']}",
            "screenshot": (scene.get("paths") or {}).get("screenshot"),
            "width": w,
            "height": h,
            "ratio": round(ratio, 3),
        }

        if is_wide and not has_vr:
            entry["action"] = "add"
            needs_add.append(entry)
        elif has_vr and not is_wide:
            entry["action"] = "remove"
            needs_remove.append(entry)

    result = {
        "status": "done",
        "generated_at": int(time.time()),
        "tag_name": tag_name,
        "tag_id": vr_tag_id,
        "threshold": threshold,
        "total_scenes": len(scenes),
        "needs_add": needs_add,
        "needs_remove": needs_remove,
        "skipped_count": len(skipped),
    }

    os.makedirs(ASSETS_DIR, exist_ok=True)
    out_path = os.path.join(ASSETS_DIR, "audit.json")
    with open(out_path, "w") as fp:
        json.dump(result, fp)

    print(f"Done. {len(needs_add)} need ADD, {len(needs_remove)} need REMOVE, "
          f"{len(skipped)} skipped. Wrote {out_path}", flush=True)


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        print("ERROR: stdin is empty.", flush=True)
        sys.exit(1)
    input_data = json.loads(raw)
    sc = input_data.get("server_connection", {})
    scheme = sc.get("Scheme", "http")
    port = sc.get("Port", 9999)
    apikey = sc.get("ApiKey", "")

    global SESSION_COOKIE, PLUGIN_DIR, ASSETS_DIR
    if not apikey:
        cookie = sc.get("SessionCookie", {}) or {}
        if cookie.get("Value"):
            SESSION_COOKIE = f"{cookie.get('Name', 'session')}={cookie['Value']}"

    plugin_dir = sc.get("PluginDir", "")
    if plugin_dir:
        PLUGIN_DIR = plugin_dir
        ASSETS_DIR = os.path.join(PLUGIN_DIR, "assets")
    os.makedirs(ASSETS_DIR, exist_ok=True)

    url = f"{scheme}://localhost:{port}/graphql"

    raw_args = input_data.get("args", {}) or {}
    task_name = raw_args.get("mode", "") if isinstance(raw_args, dict) else ""
    print(f"Task={task_name!r}", flush=True)

    if task_name == "Audit VR Tags":
        config_res = graphql_query(url, apikey, "query { configuration { plugins } }")
        plugins_config = config_res.get("data", {}).get("configuration", {}).get("plugins", {}) or {}
        task_audit_vr_tags(url, apikey, plugins_config)
    else:
        print(f"Unknown task: {task_name!r}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()