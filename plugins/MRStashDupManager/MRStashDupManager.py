import sys
import json
import urllib.request
import urllib.error
import os
import re
import logging

PLUGIN_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
ASSETS_DIR = os.path.join(PLUGIN_DIR, "assets")
SESSION_COOKIE = None

DUPLICATE_TAG_NAME = "_DuplicateMarkForDeletion"
EXCLUDE_TAG_NAME = "_DuplicateExclude"

# ---------------------------------------------------------------------------
# Matching presets — mirror Stash's native Scene Duplicate Checker dropdowns
# ---------------------------------------------------------------------------
# Search accuracy -> phash hamming distance
#   Exact = 0, High = 3, Medium = 6, Low = 8
#   Loose = 12 is ABOVE Stash's native "Low" ceiling of 8. It catches pairs whose
#   frame sampling has drifted (e.g. an added intro/outro shifts the phash), at
#   the cost of more false positives — always eyeball the sprite grid before
#   deleting a Loose-only match.
ACCURACY_TO_DISTANCE = {
    "exact": 0,
    "high": 3,
    "medium": 6,
    "low": 8,
    "loose": 12,
}
# Duration filter -> duration_diff seconds
#   Any = -1 (disabled), Equal = 0, then 1 / 5 / 10 seconds
DURATION_TO_DIFF = {
    "any": -1.0,
    "equal": 0.0,
    "1": 1.0,
    "5": 5.0,
    "10": 10.0,
}

DEFAULT_ACCURACY = "exact"
DEFAULT_DURATION = "1"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="[MRStashDupManager] %(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("MRStashDupManager")


# ── GraphQL ────────────────────────────────────────────────────────────────────
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
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as e:
        log.error("GraphQL request failed: %s", e)
        raise
    if payload.get("errors"):
        # Surface the first error message but keep going where possible
        msg = payload["errors"][0].get("message", "unknown GraphQL error")
        log.error("GraphQL error: %s", msg)
        raise RuntimeError(msg)
    return payload.get("data", {})


def get_configuration(url, apikey):
    """Read plugin settings out of Stash's saved configuration."""
    try:
        data = graphql_query(url, apikey, """
            query { configuration { plugins } }
        """)
        plugins = (data.get("configuration") or {}).get("plugins") or {}
        return plugins.get("MRStashDupManager", {}) or {}
    except Exception as e:
        log.warning("Could not load plugin configuration: %s", e)
        return {}


def find_duplicate_scenes(url, apikey, distance, duration_diff):
    """
    Call Stash's built-in duplicate finder. Returns a list of groups; each group
    is a list of scene objects that share (near-)identical perceptual hashes.
    """
    query = """
        query FindDuplicateScenes($distance: Int, $duration_diff: Float) {
            findDuplicateScenes(distance: $distance, duration_diff: $duration_diff) {
                id
                title
                details
                rating100
                organized
                date
                studio { id name }
                tags { id name }
                performers { id name }
                galleries { id }
                paths {
                    sprite
                    screenshot
                }
                files {
                    id
                    path
                    size
                    duration
                    width
                    height
                    video_codec
                    audio_codec
                    bit_rate
                    frame_rate
                }
            }
        }
    """
    variables = {"distance": distance, "duration_diff": duration_diff}
    data = graphql_query(url, apikey, query, variables)
    return data.get("findDuplicateScenes", []) or []


# Fields fetched for every scene, whichever pass found it. Kept identical to the
# phash query's selection so build_member() can treat both sources the same.
_SCENE_FIELDS = """
    id
    title
    details
    rating100
    organized
    date
    studio { id name }
    tags { id name }
    performers { id name }
    galleries { id }
    stash_ids { endpoint stash_id }
    paths {
        sprite
        screenshot
    }
    files {
        id
        path
        size
        duration
        width
        height
        video_codec
        audio_codec
        bit_rate
        frame_rate
    }
"""


def find_stash_id_duplicate_groups(url, apikey):
    """
    Find duplicates by shared stash-box id. Two files matched to the same
    catalogued scene on the same stash-box endpoint are the same content by
    definition — independent of phash — so this catches pairs whose perceptual
    hashes have drifted too far to group (e.g. an added intro/outro).

    Returns a list of groups (each a list of scene objects), same shape as
    find_duplicate_scenes, so the two passes can be merged uniformly.
    """
    # Page through all scenes that carry at least one stash_id. The
    # stash_id_endpoint filter with NOT_NULL returns only identified scenes,
    # which keeps this far cheaper than walking the whole library.
    query = """
        query FindStashIdScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
            findScenes(filter: $filter, scene_filter: $scene_filter) {
                count
                scenes { %s }
            }
        }
    """ % _SCENE_FIELDS

    scene_filter = {"stash_id_endpoint": {"modifier": "NOT_NULL"}}
    per_page = 200
    page = 1
    all_scenes = []
    while True:
        variables = {
            "filter": {"per_page": per_page, "page": page, "sort": "id", "direction": "ASC"},
            "scene_filter": scene_filter,
        }
        data = graphql_query(url, apikey, query, variables)
        result = data.get("findScenes") or {}
        scenes = result.get("scenes") or []
        all_scenes.extend(scenes)
        total = result.get("count") or 0
        if page * per_page >= total or not scenes:
            break
        page += 1

    # Bucket by (endpoint, stash_id). A scene can carry ids from multiple
    # endpoints, so it may land in more than one bucket; the later merge step
    # collapses any groups that end up sharing scenes.
    buckets = {}
    for s in all_scenes:
        for sid in (s.get("stash_ids") or []):
            endpoint = (sid.get("endpoint") or "").strip()
            value = (sid.get("stash_id") or "").strip()
            if not value:
                continue
            buckets.setdefault((endpoint, value), []).append(s)

    # Only keep buckets with 2+ distinct scenes.
    groups = []
    for (endpoint, value), scenes in buckets.items():
        seen = {}
        for s in scenes:
            seen[s["id"]] = s  # dedupe by scene id within a bucket
        if len(seen) >= 2:
            groups.append(list(seen.values()))
    return groups


def _merge_scene_groups(*group_lists):
    """
    Union any groups (from either pass) that share one or more scene ids, so a
    pair caught by both phash AND stash-id becomes a single review group rather
    than two near-identical ones.

    Returns a list of (scenes, match_types) tuples, where match_types is a set
    like {"phash"}, {"stash_id"}, or {"phash", "stash_id"} describing why the
    group was flagged.
    """
    # Each raw group is tagged with its source as we ingest it.
    tagged = []  # list of [set_of_scene_ids, {id: scene}, set_of_match_types]
    sources = ("phash", "stash_id")
    for src, glist in zip(sources, group_lists):
        for scenes in glist:
            ids = {s["id"] for s in scenes}
            by_id = {s["id"]: s for s in scenes}
            tagged.append([ids, by_id, {src}])

    # Iteratively coalesce groups that overlap on any scene id.
    merged = []
    for ids, by_id, mtypes in tagged:
        hit = None
        for existing in merged:
            if existing[0] & ids:
                hit = existing
                break
        if hit:
            hit[0] |= ids
            hit[1].update(by_id)
            hit[2] |= mtypes
        else:
            merged.append([set(ids), dict(by_id), set(mtypes)])

    # A second pass catches transitive overlaps (A∩B and B∩C but not A∩C on the
    # first sweep). Repeat until stable.
    changed = True
    while changed:
        changed = False
        out = []
        for grp in merged:
            hit = None
            for existing in out:
                if existing[0] & grp[0]:
                    hit = existing
                    break
            if hit:
                hit[0] |= grp[0]
                hit[1].update(grp[1])
                hit[2] |= grp[2]
                changed = True
            else:
                out.append(grp)
        merged = out

    return [(list(by_id.values()), mtypes) for _ids, by_id, mtypes in merged]


def ensure_tag_exists(url, apikey, tag_name):
    data = graphql_query(url, apikey, "query { allTags { id name } }")
    for t in data.get("allTags", []):
        if t["name"].lower() == tag_name.lower():
            return {"id": t["id"], "name": t["name"]}
    log.info("Creating tag '%s'...", tag_name)
    created = graphql_query(url, apikey, """
        mutation TagCreate($input: TagCreateInput!) {
            tagCreate(input: $input) { id name }
        }
    """, {"input": {"name": tag_name}})
    tag = created.get("tagCreate")
    if not tag:
        raise RuntimeError(f"Failed to create tag '{tag_name}'")
    return tag


# ── Setting / preset resolution ────────────────────────────────────────────────
def _clean_label(v):
    return str(v or "").strip().lower()


def resolve_distance(accuracy_label, cfg):
    """
    Resolve the phash distance from (in priority order):
      1. an explicit accuracy label passed to the scan (Exact/High/Medium/Low)
      2. a numeric matchDistance in plugin settings (back-compat)
      3. the accuracy label saved in plugin settings
      4. the default (exact / 0)
    Returns (distance:int, accuracy_label:str).
    """
    lbl = _clean_label(accuracy_label)
    if lbl in ACCURACY_TO_DISTANCE:
        return ACCURACY_TO_DISTANCE[lbl], lbl

    # Back-compat: a raw numeric matchDistance in settings still wins if present.
    raw = cfg.get("matchDistance")
    if raw not in (None, ""):
        try:
            d = int(raw)
            # Map the number back to the closest label for display purposes.
            nearest = min(ACCURACY_TO_DISTANCE.items(), key=lambda kv: abs(kv[1] - d))[0]
            return d, nearest
        except (TypeError, ValueError):
            pass

    lbl_cfg = _clean_label(cfg.get("accuracy"))
    if lbl_cfg in ACCURACY_TO_DISTANCE:
        return ACCURACY_TO_DISTANCE[lbl_cfg], lbl_cfg

    return ACCURACY_TO_DISTANCE[DEFAULT_ACCURACY], DEFAULT_ACCURACY


def resolve_duration_diff(duration_label, cfg):
    """
    Resolve duration_diff seconds from (in priority order):
      1. an explicit duration label passed to the scan (Any/Equal/1/5/10)
      2. a numeric durationDiff in plugin settings (back-compat)
      3. the duration label saved in plugin settings
      4. the default (1 second)
    Returns (duration_diff:float, duration_label:str).
    """
    lbl = _clean_label(duration_label)
    if lbl in DURATION_TO_DIFF:
        return DURATION_TO_DIFF[lbl], lbl

    raw = cfg.get("durationDiff")
    if raw not in (None, ""):
        try:
            d = float(raw)
            # Map the number back to the closest label for display.
            if d < 0:
                return -1.0, "any"
            nearest = min(DURATION_TO_DIFF.items(),
                          key=lambda kv: abs(kv[1] - d) if kv[1] >= 0 else 1e9)[0]
            return d, nearest
        except (TypeError, ValueError):
            pass

    lbl_cfg = _clean_label(cfg.get("duration"))
    if lbl_cfg in DURATION_TO_DIFF:
        return DURATION_TO_DIFF[lbl_cfg], lbl_cfg

    return DURATION_TO_DIFF[DEFAULT_DURATION], DEFAULT_DURATION


# ── Preference / scoring ───────────────────────────────────────────────────────
def _norm_path(p):
    return (p or "").replace("\\", "/").lower()


def _path_list(raw):
    """Split a comma/semicolon/newline separated path list from settings."""
    if not raw:
        return []
    parts = re.split(r"[,;\n]+", raw)
    return [_norm_path(p.strip()) for p in parts if p.strip()]


def path_rank(path, whitelist, graylist, blacklist):
    """
    Lower number = more preferred to KEEP.
      0 = whitelist (never delete)
      1 = neutral / unknown path
      2 = graylist (secondary)
      3 = blacklist (delete first)
    """
    np = _norm_path(path)
    if any(np.startswith(w) or w in np for w in whitelist):
        return 0
    if any(np.startswith(b) or b in np for b in blacklist):
        return 3
    if any(np.startswith(g) or g in np for g in graylist):
        return 2
    return 1


def primary_file(scene):
    files = scene.get("files") or []
    return files[0] if files else {}


def scene_metrics(scene):
    f = primary_file(scene)
    width = f.get("width") or 0
    height = f.get("height") or 0
    return {
        "resolution": width * height,
        "height": height,
        "duration": f.get("duration") or 0,
        "size": f.get("size") or 0,
        "bit_rate": f.get("bit_rate") or 0,
        "path": f.get("path") or "",
        "file_id": f.get("id"),
    }


def choose_keeper(scenes, whitelist, graylist, blacklist):
    """
    Decide which scene in a duplicate group should be kept.

    Preference order:
      1. path rank (whitelist beats graylist beats blacklist)
      2. higher resolution
      3. higher bitrate
      4. larger file size
      5. longer duration
      6. longer path (usually better organised / deeper folder)

    Returns the index of the keeper within `scenes`.
    """
    best_idx = 0
    best_key = None
    for i, s in enumerate(scenes):
        m = scene_metrics(s)
        rank = path_rank(m["path"], whitelist, graylist, blacklist)
        # Negate the things where "bigger is better" so a plain min() picks the keeper.
        # Bitrate and size come before duration: a longer copy is often just an
        # added intro/outro bumper on a re-encode, not a better source, so we don't
        # want extra runtime to outweigh a cleaner, higher-bitrate file.
        key = (
            rank,
            -m["resolution"],
            -m["bit_rate"],
            -m["size"],
            -round(m["duration"]),
            -len(m["path"]),
        )
        if best_key is None or key < best_key:
            best_key = key
            best_idx = i
    return best_idx


def reason_for_deletion(keeper_m, cand_m, cand_rank, keeper_rank):
    reasons = []
    if cand_rank > keeper_rank:
        label = {1: "neutral", 2: "gray-list", 3: "black-list"}.get(cand_rank, "")
        reasons.append(f"lower-priority path ({label})")
    if cand_m["resolution"] < keeper_m["resolution"]:
        reasons.append("lower resolution")
    if cand_m["bit_rate"] < keeper_m["bit_rate"]:
        reasons.append("lower bitrate")
    if cand_m["size"] < keeper_m["size"]:
        reasons.append("smaller file")
    if round(cand_m["duration"]) < round(keeper_m["duration"]):
        reasons.append("shorter duration")
    if not reasons:
        reasons.append("duplicate of kept scene")
    return reasons


# ── Group / member building ────────────────────────────────────────────────────
def build_group(scenes, match_types, group_id, whitelist, graylist, blacklist):
    """
    Turn a raw list of duplicate scene objects into a report group dict.
    `match_types` is a set describing why the group was flagged ('phash',
    'stash_id', or both). Returns (group_dict, reclaimable_bytes) or (None, 0)
    if the group is too small to be meaningful.
    """
    scenes = [s for s in scenes if (s.get("files") or [])]
    if len(scenes) < 2:
        return None, 0

    keeper_idx = choose_keeper(scenes, whitelist, graylist, blacklist)
    keeper_m = scene_metrics(scenes[keeper_idx])
    keeper_rank = path_rank(keeper_m["path"], whitelist, graylist, blacklist)

    match_list = sorted(match_types)
    reclaimable = 0
    members = []
    for i, s in enumerate(scenes):
        m = scene_metrics(s)
        f = primary_file(s)
        paths = s.get("paths") or {}
        is_keeper = (i == keeper_idx)
        rank = path_rank(m["path"], whitelist, graylist, blacklist)
        excluded = any(t["name"].lower() == EXCLUDE_TAG_NAME.lower()
                       for t in (s.get("tags") or []))

        member = {
            "scene_id": s["id"],
            "file_id": f.get("id"),
            "title": s.get("title") or os.path.basename(m["path"]),
            "details": s.get("details") or "",
            "path": m["path"],
            "sprite": paths.get("sprite"),
            "screenshot": paths.get("screenshot"),
            "size": m["size"],
            "duration": m["duration"],
            "width": f.get("width") or 0,
            "height": f.get("height") or 0,
            "video_codec": f.get("video_codec") or "",
            "bit_rate": m["bit_rate"],
            "frame_rate": f.get("frame_rate") or 0,
            "resolution": m["resolution"],
            "rating100": s.get("rating100"),
            "organized": s.get("organized", False),
            "date": s.get("date"),
            "studio": (s.get("studio") or {}).get("name") if s.get("studio") else None,
            "tags": [{"id": t["id"], "name": t["name"]} for t in (s.get("tags") or [])],
            "performers": [{"id": p["id"], "name": p["name"]} for p in (s.get("performers") or [])],
            "stash_ids": [{"endpoint": x.get("endpoint"), "stash_id": x.get("stash_id")}
                          for x in (s.get("stash_ids") or [])],
            "path_rank": rank,
            "is_keeper": is_keeper,
            "excluded": excluded,
            "delete_risk": _delete_would_overflow(m["path"]),
        }
        if not is_keeper:
            member["reasons"] = reason_for_deletion(keeper_m, m, rank, keeper_rank)
            reclaimable += m["size"]
        members.append(member)

    group = {
        "group_id": group_id,
        "keeper_scene_id": scenes[keeper_idx]["id"],
        "match_types": match_list,
        "members": members,
    }
    return group, reclaimable


# ── Scan task ─────────────────────────────────────────────────────────────────
def task_scan(url, apikey, accuracy_label=None, duration_label=None):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    _write_status({"status": "running", "message": "Loading configuration...", "progress": 0})

    cfg = get_configuration(url, apikey)

    distance, accuracy_used = resolve_distance(accuracy_label, cfg)
    duration_diff, duration_used = resolve_duration_diff(duration_label, cfg)

    whitelist = _path_list(cfg.get("whitelist"))
    graylist = _path_list(cfg.get("graylist"))
    blacklist = _path_list(cfg.get("blacklist"))

    log.info("accuracy=%s(distance=%s) duration=%s(diff=%s) whitelist=%s graylist=%s blacklist=%s",
             accuracy_used, distance, duration_used, duration_diff, whitelist, graylist, blacklist)

    _write_status({"status": "running", "message": "Querying Stash for phash duplicates...", "progress": 10})
    try:
        phash_groups = find_duplicate_scenes(url, apikey, distance, duration_diff)
    except Exception as e:
        msg = str(e)
        if "phash" in msg.lower():
            msg = ("Stash returned a phash error. Run the "
                   "'Generate Phashes' scan task first, then try again. (" + msg + ")")
        _write_status({"status": "error", "message": msg})
        _write_report({"status": "error", "message": msg, "groups": []})
        return

    # Second pass: group by shared stash-box id. This catches content-identical
    # pairs whose phashes drifted apart (added intro/outro, re-encode) — the case
    # phash distance can't reach even at the Loose ceiling. Non-fatal if it fails:
    # we still return the phash results.
    _write_status({"status": "running",
                   "message": "Querying Stash for stash-id matches...", "progress": 35})
    try:
        stash_id_groups = find_stash_id_duplicate_groups(url, apikey)
    except Exception as e:
        log.warning("stash-id pass failed (continuing with phash only): %s", e)
        stash_id_groups = []

    # Merge the two passes so a pair caught by both is one group, tagged with why.
    merged = _merge_scene_groups(phash_groups, stash_id_groups)

    _write_status({"status": "running",
                   "message": f"Analyzing {len(merged)} duplicate groups...",
                   "progress": 60})

    report_groups = []
    total_reclaimable = 0

    for gi, (scenes, match_types) in enumerate(merged):
        group, reclaimable = build_group(
            scenes, match_types, gi, whitelist, graylist, blacklist
        )
        if group is None:
            continue
        report_groups.append(group)
        total_reclaimable += reclaimable

    report = {
        "status": "done",
        "groups": report_groups,
        "total_groups": len(report_groups),
        "total_reclaimable_bytes": total_reclaimable,
        "settings": {
            "distance": distance,
            "duration_diff": duration_diff,
            "accuracy": accuracy_used,
            "duration": duration_used,
            "whitelist": whitelist,
            "graylist": graylist,
            "blacklist": blacklist,
        },
    }
    _write_report(report)
    _write_status({"status": "done",
                   "message": f"Found {len(report_groups)} duplicate groups.",
                   "progress": 100})
    log.info("Scan complete: %s groups (%s phash, %s stash-id raw), %.2f GB reclaimable",
             len(report_groups), len(phash_groups), len(stash_id_groups),
             total_reclaimable / (1024 ** 3))


# ── Filename-length safety helper ──────────────────────────────────────────────
DELETE_SUFFIX = ".delete"
MAX_NAME_BYTES = 255  # ext4/xfs/apfs; lower for SMB/eCryptfs shares


def _delete_would_overflow(path, suffix=DELETE_SUFFIX, limit=MAX_NAME_BYTES):
    """
    True if Stash's soft-delete rename (append '.delete' to the basename) would
    exceed the filesystem's per-component byte limit. The UI uses this to warn
    and to trigger a rename-first fallback before deletion.
    """
    base = os.path.basename((path or "").replace("\\", "/"))
    return len(base.encode("utf-8")) + len(suffix.encode("utf-8")) > limit


# ── Tag task (optional convenience) ────────────────────────────────────────────
def task_tag_duplicates(url, apikey, accuracy_label=None, duration_label=None):
    """
    Re-run the scan logic and apply the _DuplicateMarkForDeletion tag to every
    non-keeper scene. Useful for users who prefer to review via Stash's normal
    tag/library UI before deleting.
    """
    os.makedirs(ASSETS_DIR, exist_ok=True)
    _write_status({"status": "running", "message": "Tagging duplicates...", "progress": 0})

    cfg = get_configuration(url, apikey)
    distance, accuracy_used = resolve_distance(accuracy_label, cfg)
    duration_diff, duration_used = resolve_duration_diff(duration_label, cfg)
    whitelist = _path_list(cfg.get("whitelist"))
    graylist = _path_list(cfg.get("graylist"))
    blacklist = _path_list(cfg.get("blacklist"))

    log.info("tag: accuracy=%s(distance=%s) duration=%s(diff=%s)",
             accuracy_used, distance, duration_used, duration_diff)

    dup_tag = ensure_tag_exists(url, apikey, DUPLICATE_TAG_NAME)
    groups = find_duplicate_scenes(url, apikey, distance, duration_diff)

    tagged = 0
    for scenes in groups:
        scenes = [s for s in scenes if (s.get("files") or [])]
        if len(scenes) < 2:
            continue
        keeper_idx = choose_keeper(scenes, whitelist, graylist, blacklist)
        for i, s in enumerate(scenes):
            if i == keeper_idx:
                continue
            existing = [t["id"] for t in (s.get("tags") or [])]
            if dup_tag["id"] in existing:
                continue
            graphql_query(url, apikey, """
                mutation SceneUpdate($input: SceneUpdateInput!) {
                    sceneUpdate(input: $input) { id }
                }
            """, {"input": {"id": s["id"], "tag_ids": existing + [dup_tag["id"]]}})
            tagged += 1

    _write_status({"status": "done",
                   "message": f"Tagged {tagged} duplicate scenes with {DUPLICATE_TAG_NAME}.",
                   "progress": 100})
    log.info("Tagged %s duplicate scenes", tagged)


# ── Asset writers ─────────────────────────────────────────────────────────────
def _write_status(data):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    with open(os.path.join(ASSETS_DIR, "dup_status.json"), "w") as f:
        json.dump(data, f)


def _write_report(data):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    with open(os.path.join(ASSETS_DIR, "dup_report.json"), "w") as f:
        json.dump(data, f)


# ── Arg parsing ───────────────────────────────────────────────────────────────
def _extract_args(input_data):
    """
    Pull mode/accuracy/duration out of the plugin invocation. Stash passes
    plugin-task args under 'args'; the UI (runPluginTask) sends them as a flat
    dict. Falls back to the task name for menu-triggered runs.
    """
    raw_args = input_data.get("args", {})
    if not isinstance(raw_args, dict):
        raw_args = {}

    mode = raw_args.get("mode", "")
    accuracy = raw_args.get("accuracy")
    duration = raw_args.get("duration")

    task_name = mode or input_data.get("task", {}).get("name", "")
    return task_name, accuracy, duration


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    raw_stdin = sys.stdin.read()
    if not raw_stdin.strip():
        print("ERROR: stdin is empty.", flush=True)
        sys.exit(1)
    input_data = json.loads(raw_stdin)

    server_connection = input_data.get("server_connection", {})
    scheme = server_connection.get("Scheme", "http")
    port = server_connection.get("Port", 9999)
    apikey = server_connection.get("ApiKey", "")

    if not apikey:
        cookie_obj = server_connection.get("SessionCookie", {})
        cookie_name = cookie_obj.get("Name", "session")
        cookie_value = cookie_obj.get("Value", "")
        if cookie_value:
            global SESSION_COOKIE
            SESSION_COOKIE = f"{cookie_name}={cookie_value}"

    plugin_dir_from_stash = server_connection.get("PluginDir", "")
    if plugin_dir_from_stash:
        # Prefer the script's own directory — it's physically inside the plugin
        # folder that Stash serves at /plugin/<id>/assets/. PluginDir from the
        # server connection can point elsewhere on some setups, which breaks the
        # asset polling with a permanent 404.
        global PLUGIN_DIR, ASSETS_DIR
        script_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
        if os.path.isdir(script_dir):
            PLUGIN_DIR = script_dir
        else:
            plugin_dir_from_stash = server_connection.get("PluginDir", "")
            if plugin_dir_from_stash:
                PLUGIN_DIR = plugin_dir_from_stash
        ASSETS_DIR = os.path.join(PLUGIN_DIR, "assets")
        os.makedirs(ASSETS_DIR, exist_ok=True)
        print(f"Writing assets to: {ASSETS_DIR}", flush=True)

    url = f"{scheme}://localhost:{port}/graphql"

    task_name, accuracy, duration = _extract_args(input_data)

    print(f"Task={task_name!r} accuracy={accuracy!r} duration={duration!r} PluginDir={PLUGIN_DIR!r}",
          flush=True)

    try:
        if task_name == "Scan for Duplicates":
            task_scan(url, apikey, accuracy, duration)
        elif task_name == "Tag Duplicates":
            task_tag_duplicates(url, apikey, accuracy, duration)
        else:
            print(f"Unknown task: {task_name!r}", flush=True)
            sys.exit(1)
    except Exception as e:
        log.exception("Task failed")
        _write_status({"status": "error", "message": str(e)})


if __name__ == "__main__":
    main()