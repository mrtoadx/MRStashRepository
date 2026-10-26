import sys
import json
import urllib.request
import urllib.error
import os
import re
import shutil
import time
import logging

PLUGIN_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
ASSETS_DIR = os.path.join(PLUGIN_DIR, "assets")
SESSION_COOKIE = None

MISSING_STUDIO_TAG_NAME = "MissingStudio"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="[MRStashSanitize] %(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("MRStashSanitize")

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
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as e:
        print(f"GraphQL request failed: {e}", flush=True)
        sys.exit(1)


def get_all_tags(url, apikey):
    """Return {tag_name_lower: {id, name}} for every tag in Stash."""
    res = graphql_query(url, apikey, """
    query { allTags { id name aliases } }
    """)
    tags = res.get("data", {}).get("allTags", [])
    lookup = {}
    for t in tags:
        lookup[t["name"].lower()] = {"id": t["id"], "name": t["name"]}
        for alias in (t.get("aliases") or []):
            if alias.lower() not in lookup:
                lookup[alias.lower()] = {"id": t["id"], "name": t["name"]}
    return lookup


def ensure_tag_exists(url, apikey, tag_name):
    """
    Look up a tag by name and create it if missing.
    Uses allTags (version-stable, no filter syntax issues).
    Returns {"id": ..., "name": ...}.
    """
    res = graphql_query(url, apikey, "query { allTags { id name } }")
    all_tags = res.get("data", {}).get("allTags", [])
    for t in all_tags:
        if t["name"].lower() == tag_name.lower():
            log.info("Tag '%s' already exists (id=%s)", tag_name, t["id"])
            return {"id": t["id"], "name": t["name"]}

    log.info("Creating tag '%s'...", tag_name)
    create_res = graphql_query(url, apikey, """
    mutation TagCreate($input: TagCreateInput!) {
      tagCreate(input: $input) { id name }
    }
    """, {"input": {"name": tag_name}})
    tag = create_res.get("data", {}).get("tagCreate")
    if tag:
        log.info("Created tag '%s' (id=%s)", tag["name"], tag["id"])
        return tag
    raise RuntimeError(f"Failed to create tag '{tag_name}'")


def get_scenes_paginated(url, apikey, page=1, per_page=100):
    res = graphql_query(url, apikey, """
    query FindScenes($filter: FindFilterType) {
      findScenes(filter: $filter) {
        count
        scenes {
          id title date
          tags { id name }
          files { id path size }
          studio { id name }
        }
      }
    }
    """, {"filter": {"page": page, "per_page": per_page, "sort": "id", "direction": "ASC"}})
    d = res.get("data", {}).get("findScenes", {})
    return d.get("count", 0), d.get("scenes", [])


def update_scene(url, apikey, scene_id, new_title, tag_ids):
    """Update scene title and tags via GraphQL."""
    res = graphql_query(url, apikey, """
    mutation SceneUpdate($input: SceneUpdateInput!) {
      sceneUpdate(input: $input) { id }
    }
    """, {"input": {"id": scene_id, "title": new_title, "tag_ids": tag_ids}})
    return res.get("data", {}).get("sceneUpdate")


def move_file(url, apikey, file_id, new_path):
    """Use Stash's moveFiles mutation to rename/move a file."""
    dest_folder   = os.path.dirname(new_path)
    dest_basename = os.path.basename(new_path)

    log.warning("move_file asset dest_folder=%s dest_basename=%s new_path=%s", dest_folder, dest_basename, new_path)
    res = graphql_query(url, apikey, """
    mutation MoveFiles($input: MoveFilesInput!) {
      moveFiles(input: $input)
    }
    """, {"input": {"ids": [file_id], "destination_folder": dest_folder, "destination_basename": dest_basename}})
    return res.get("data", {}).get("moveFiles", False)


# ── Studio folder naming ───────────────────────────────────────────────────────

def studio_to_folder_name(studio_name):
    """
    Convert a studio name to a CamelCase directory name with no spaces.
    "Some Studio Name" → "SomeStudioName"
    """
    if not studio_name:
        return ""
    parts = re.split(r'[\s_\-]+', studio_name)
    return "".join(p[:1].upper() + p[1:] for p in parts if p)


# ── Poor-directory detection ───────────────────────────────────────────────────

def _normalise_for_compare(s):
    """Lowercase, strip non-alphanumeric, collapse spaces — used for fuzzy dir/stem matching."""
    return re.sub(r'[^a-z0-9]', '', s.lower())


def is_self_titled_dir(dir_name, file_stem):
    """
    Return True when the parent directory looks like it was named after this
    specific file (a one-file "self-titled" folder).

    Heuristics
    ----------
    • Normalised dir == normalised stem  (exact after stripping punctuation/case)
    • Normalised dir is a prefix of normalised stem ≥ 80 % of stem length
      (handles truncated folder names like "SomeLongTitle" / "SomeLongTitle_Part1")
    • Normalised stem starts with normalised dir and the remainder is ≤ 12 chars
      (e.g. dir="SceneName", stem="SceneName_4K_1080p")
    """
    nd = _normalise_for_compare(dir_name)
    ns = _normalise_for_compare(file_stem)
    if not nd or not ns:
        return False
    if nd == ns:
        return True
    # dir is a long prefix of stem
    if ns.startswith(nd) and len(nd) >= max(6, int(len(ns) * 0.75)):
        return True
    # stem starts with dir and only a short suffix remains
    if ns.startswith(nd) and (len(ns) - len(nd)) <= 12:
        return True
    return False


def classify_directory(path, studio_folder):
    """
    Classify why a scene's directory is "poor".

    Returns one of:
      "ok"          – already in the correct studio folder
      "wrong_studio"– parent dir doesn't match expected studio folder
      "self_titled" – parent dir appears named after this specific file
      "shallow"     – file sits only 1 level below a filesystem root
                      (e.g. /videos/scene.mp4 — depth < 2 usable components)

    `studio_folder` may be None if the scene has no studio assigned.
    """
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    # parts[-1] is the filename; parts[-2] is the immediate parent dir
    if len(parts) < 2:
        return "shallow"

    parent_dir  = parts[-2]
    file_stem   = os.path.splitext(parts[-1])[0]

    # Shallow: file is only one directory deep from root
    if len(parts) == 2:
        return "shallow"

    if studio_folder:
        if parent_dir == studio_folder:
            return "ok"
        # Self-titled takes priority over wrong_studio so the UI message is accurate
        if is_self_titled_dir(parent_dir, file_stem):
            return "self_titled"
        return "wrong_studio"
    else:
        # No studio — still flag self-titled / shallow dirs
        if is_self_titled_dir(parent_dir, file_stem):
            return "self_titled"
        return "ok"   # no studio, not self-titled → nothing we can do without more info


# ── Tag affix / phrase helpers ─────────────────────────────────────────────────

def strip_tag_affixes(s):
    """
    Remove leading/trailing sigils and separators from a parsed tag string.

    A parsed tag must never carry a leading or trailing underscore, dash, or
    hash. Interior separators are preserved (they get normalised to spaces by
    token_to_phrase), only the edges are trimmed.
    """
    return re.sub(r'^[_\-#\s]+|[_\-#\s]+$', '', s or '')


def token_to_phrase(raw_token):
    """
    Convert a raw filename token (e.g. '_BigAss', '#Blonde', 'Outdoor_Scene')
    into a normalised, lower-case tag phrase ('big ass', 'blonde',
    'outdoor scene'). Leading/trailing sigils are always stripped first, so the
    resulting phrase never begins or ends with _ - or #.
    """
    s = strip_tag_affixes(raw_token)
    if not s:
        return ''
    if s[0].isdigit():
        return s.lower()
    # Split on separators, then split CamelCase runs within each part.
    parts = re.split(r'[_\-\s]+', s)
    words = []
    for part in parts:
        found = re.findall(r'[A-Z]?[a-z]+|[A-Z]+(?=[A-Z]|$)|\d+', part)
        words.extend(found or ([part] if part else []))
    return ' '.join(w.lower() for w in words if w)


# ── Sigil token extraction ─────────────────────────────────────────────────────
#
# We only treat *sigil-prefixed* tokens ( _Word / #Word ) as tag candidates.
# Plain CamelCase words and ordinary underscore-separated title words are NOT
# harvested as tags — that was the old behaviour that shredded legitimate
# titles like "Some_Studio_-_A_Long_Title_With_Many_Words".

SIGIL_WORD_RE = re.compile(
    r'(?<![A-Za-z0-9])'          # not mid-word
    r'([_#])'                    # a single sigil
    r'([A-Za-z][A-Za-z0-9]*)'    # the word itself
    r'(?![A-Za-z0-9])'
)


def extract_candidate_tokens(filename_no_ext):
    """
    Extract sigil-prefixed tag candidates ( _Word / #Word ).

    Returns (sigil_tokens, other_tokens). other_tokens is retained for API
    compatibility but is now always empty — we no longer guess tags from plain
    CamelCase, which is what produced the over-aggressive stripping.
    """
    sigil_tokens = []
    other_tokens = []
    seen_raw     = set()

    for m in SIGIL_WORD_RE.finditer(filename_no_ext):
        raw = m.group(0)               # includes the leading sigil, e.g. '_Blonde'
        if raw in seen_raw:
            continue
        seen_raw.add(raw)
        phrase = token_to_phrase(raw)
        # Ignore trivial single-character words (e.g. the "_A" in
        # "..._-_A_Long_Title...") — these are almost always title words, not
        # tags, and treating them as candidates is what caused over-stripping.
        if phrase and len(phrase) >= 2:
            sigil_tokens.append({"raw": raw, "phrase": phrase})

    return sigil_tokens, other_tokens


# ── Bracketed [TagA, TagB] extraction ──────────────────────────────────────────

BRACKET_GROUP_RE = re.compile(r'\[([^\[\]]*)\]')


def extract_bracket_tags(filename_no_ext):
    """
    Parse '[TagA, TagB]' style groups out of a filename.

    Returns (tags, cleaned_stem) where:
      • tags         is a list of {"raw": <original>, "phrase": <normalised>}
                     with all leading/trailing _ - # stripped from each phrase.
      • cleaned_stem is the filename with the bracket groups removed.

    Tags inside a group may be separated by comma, semicolon, or pipe.
    """
    tags = []
    seen = set()

    for m in BRACKET_GROUP_RE.finditer(filename_no_ext):
        inner = m.group(1)
        for part in re.split(r'[,;|]', inner):
            phrase = token_to_phrase(part)
            if phrase and phrase not in seen:
                seen.add(phrase)
                tags.append({"raw": strip_tag_affixes(part.strip()), "phrase": phrase})

    cleaned = BRACKET_GROUP_RE.sub(' ', filename_no_ext)
    return tags, cleaned


# ── Special-character sanitisation ─────────────────────────────────────────────

# Characters that are illegal or undesirable in filenames. We keep letters,
# digits, spaces, and a small set of safe punctuation: - _ ( ) . & ' ,
_ILLEGAL_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_UNWANTED_CHARS_RE = re.compile(r'[^\w\s\-\(\)\.\&\',]', re.UNICODE)


def sanitize_special_chars(name):
    """
    Remove characters that are illegal or messy in filenames, then tidy up
    whitespace and separators. Does not touch the extension (pass a stem).
    """
    if not name:
        return ''
    s = _ILLEGAL_CHARS_RE.sub(' ', name)
    s = _UNWANTED_CHARS_RE.sub(' ', s)
    # collapse repeated separators
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'_{2,}', '_', s)
    s = re.sub(r'-{2,}', '-', s)
    # trim stray separators around spaces (e.g. " - - ")
    s = re.sub(r'\s*-\s*-\s*', ' - ', s)
    s = re.sub(r'^[\s_\-]+|[\s_\-]+$', '', s)
    return s.strip()


# ── Metadata-based rename ──────────────────────────────────────────────────────

def year_from_scene(scene):
    """Return a 4-digit year string from a scene's date, or '' if unavailable."""
    date = scene.get("date") or ""
    m = re.match(r'(\d{4})', str(date))
    return m.group(1) if m else ''


def build_metadata_stem(studio_name, title, year):
    """
    Build a canonical '<Studio> - <Title> (<Year>)' stem from metadata.

    Any component may be missing:
      • studio + title + year → "Studio - Title (2023)"
      • title + year          → "Title (2023)"
      • studio + title        → "Studio - Title"
      • title only            → "Title"
    Special characters are stripped from studio and title. Returns '' if there
    is no usable title.
    """
    title = sanitize_special_chars(title or '')
    if not title:
        return ''
    studio = sanitize_special_chars(studio_name or '')

    if studio:
        stem = f"{studio} - {title}"
    else:
        stem = title
    if year:
        stem = f"{stem} ({year})"
    return sanitize_special_chars(stem)


# ── Filename cleanup after token removal ───────────────────────────────────────

def build_new_filename(original_stem, tokens_to_remove):
    """
    Remove the given raw tokens from a stem and tidy the result: collapse
    repeated separators, drop dangling dashes/underscores left where tokens
    used to be, and strip leading/trailing separators.
    """
    result = original_stem
    sorted_tokens = sorted(tokens_to_remove, key=lambda t: len(t["raw"]), reverse=True)
    for tok in sorted_tokens:
        result = result.replace(tok["raw"], ' ')

    # Where a token was removed we left a space, which can strand the
    # surrounding separators, e.g. "dump_ _1080p" or "Foo _ - _ x264".
    # Collapse any run of whitespace + _/- + whitespace down to a single space.
    result = re.sub(r'[ \t]*[_\-][ \t]*(?=[ \t]*[_\-])', ' ', result)  # runs of seps
    result = re.sub(r'\s+', ' ', result)
    result = re.sub(r'_{2,}', '_', result)
    result = re.sub(r'-{2,}', '-', result)
    # A single separator floating between spaces (or at an edge) is dangling.
    result = re.sub(r'(?:^|\s)[_\-](?:\s|$)', ' ', result)
    # A separator with a space on exactly one side is a leftover edge from a
    # removed token: "dump _1080p" → "dump 1080p", "A_ B" → "A B".
    result = re.sub(r'\s[_\-]+(?=\w)', ' ', result)
    result = re.sub(r'(?<=\w)[_\-]+\s', ' ', result)
    result = re.sub(r'\s+', ' ', result)
    result = re.sub(r'^[_\-\s]+|[_\-\s]+$', '', result)
    return result.strip()


# ── Scan task ─────────────────────────────────────────────────────────────────

def task_scan(url, apikey):
    """
    Scan all scenes for:
      1. Filenames containing tag-like tokens (original behaviour).
      2. Scenes in poor directories (self-titled, shallow, or wrong-studio folders).
      3. Scenes with no studio assigned → add MissingStudio tag.

    Writes results to assets/sanitize_report.json.
    """
    os.makedirs(ASSETS_DIR, exist_ok=True)
    _write_status({"status": "running", "message": "Loading config...", "progress": 0})

    # Config
    config_res = graphql_query(url, apikey, "query { configuration { plugins } }")
    plugins_cfg = config_res.get("data", {}).get("configuration", {}).get("plugins", {})
    my_cfg = plugins_cfg.get("MRStashSanitize", {})
    strip_unmatched = str(my_cfg.get("strip_unmatched_sigils", "true")).lower() not in ("false", "0", "no", "off")
    print(f"strip_unmatched_sigils={strip_unmatched}", flush=True)

    # Load all tags once; reused for token matching and MissingStudio check
    _write_status({"status": "running", "message": "Loading tags...", "progress": 2})
    print("Loading all tags...", flush=True)
    tag_lookup = get_all_tags(url, apikey)
    print(f"Loaded {len(tag_lookup)} tags/aliases", flush=True)

    # Ensure MissingStudio tag exists (uses already-loaded tag_lookup, only
    # hits the network if the tag needs to be created)
    _write_status({"status": "running", "message": "Ensuring system tags exist...", "progress": 4})
    missing_studio_tag = ensure_tag_exists(url, apikey, MISSING_STUDIO_TAG_NAME)
    missing_studio_tag_id = missing_studio_tag["id"]
    tag_lookup[MISSING_STUDIO_TAG_NAME.lower()] = missing_studio_tag
    log.info("MissingStudio tag id=%s", missing_studio_tag_id)

    _write_status({"status": "running", "message": "Scanning scenes…", "progress": 5})

    # ── Scenes ────────────────────────────────────────────────────────────────
    page = 1
    per_page = 100
    total_count, first_batch = get_scenes_paginated(url, apikey, page, per_page)
    all_scenes = list(first_batch)
    while len(all_scenes) < total_count:
        page += 1
        _, batch = get_scenes_paginated(url, apikey, page, per_page)
        if not batch:
            break
        all_scenes.extend(batch)

    print(f"Total scenes: {total_count}, fetched: {len(all_scenes)}", flush=True)

    pending = []

    for idx, scene in enumerate(all_scenes):
        if idx % 50 == 0:
            pct = 5 + int(idx / max(len(all_scenes), 1) * 90)
            _write_status({"status": "running",
                           "message": f"Scanning {idx+1}/{len(all_scenes)}…",
                           "progress": pct})

        files = scene.get("files", [])
        if not files:
            continue
        file = files[0]
        path = file.get("path", "")
        if not path:
            continue

        file_dirname    = os.path.dirname(path)
        basename_orig   = os.path.basename(path)
        stem, ext       = os.path.splitext(basename_orig)

        studio          = scene.get("studio")
        studio_name     = studio["name"] if studio else None
        studio_folder   = studio_to_folder_name(studio_name) if studio_name else None

        existing_tag_ids = {t["id"] for t in scene.get("tags", [])}

        # ── Bracket [TagA, TagB] extraction ───────────────────────────────────
        # These always become tags and are always removed from the filename.
        bracket_tags, stem_after_brackets = extract_bracket_tags(stem)

        # ── Sigil token analysis ( _Word / #Word ) ────────────────────────────
        sigil_tokens, _other = extract_candidate_tokens(stem_after_brackets)

        matched          = []      # sigil tokens that map to an existing tag
        unmatched_sigil  = []      # sigil tokens with no matching tag

        for c in sigil_tokens:
            phrase = c["phrase"]
            if phrase in tag_lookup:
                matched.append({
                    "raw": c["raw"],
                    "phrase": phrase,
                    "tag_id": tag_lookup[phrase]["id"],
                    "tag_name": tag_lookup[phrase]["name"],
                })
            else:
                unmatched_sigil.append({"raw": c["raw"], "phrase": phrase})

        # Bracket tags: resolve each phrase against existing tags. Unmatched
        # bracket tags are surfaced as "junk" so the user can promote them into
        # real tags from the UI (same as unmatched sigils).
        bracket_matched   = []
        bracket_unmatched = []
        for bt in bracket_tags:
            phrase = bt["phrase"]
            if phrase in tag_lookup:
                bracket_matched.append({
                    "raw": bt["raw"],
                    "phrase": phrase,
                    "tag_id": tag_lookup[phrase]["id"],
                    "tag_name": tag_lookup[phrase]["name"],
                })
            else:
                bracket_unmatched.append({"raw": bt["raw"], "phrase": phrase})

        matched.extend(bracket_matched)
        unmatched_sigil.extend(bracket_unmatched)

        # ── Filename construction ─────────────────────────────────────────────
        # Prefer a clean metadata-based name when we have a title. Otherwise,
        # fall back to token-stripping the original stem.
        title_meta = scene.get("title")
        year_meta  = year_from_scene(scene)
        metadata_stem = build_metadata_stem(studio_name, title_meta, year_meta)

        # Tokens removed from the fallback stem (matched tags + optionally
        # unmatched sigils). Bracket groups are already gone from
        # stem_after_brackets.
        tokens_to_strip = list(matched)
        if strip_unmatched:
            tokens_to_strip.extend(unmatched_sigil)

        if metadata_stem:
            new_stem      = metadata_stem
            rename_source = "metadata"
        else:
            stripped = build_new_filename(stem_after_brackets, tokens_to_strip) \
                       if (tokens_to_strip or bracket_tags) else stem_after_brackets
            new_stem      = sanitize_special_chars(stripped) or stem
            rename_source = "tokens"

        new_basename = new_stem + ext

        tags_to_add    = [m for m in matched if m["tag_id"] not in existing_tag_ids]
        tags_already   = [m for m in matched if m["tag_id"] in existing_tag_ids]
        all_tag_ids    = list(existing_tag_ids | {m["tag_id"] for m in matched})

        has_token_tag_changes  = len(tags_to_add) > 0
        has_filename_changes   = new_basename != basename_orig

        # ── Directory classification ──────────────────────────────────────────
        dir_class = classify_directory(path, studio_folder)

        # ── MissingStudio handling ────────────────────────────────────────────
        needs_missing_studio_tag = (
            studio is None
            and missing_studio_tag_id not in existing_tag_ids
        )
        if needs_missing_studio_tag:
            all_tag_ids = list(set(all_tag_ids) | {missing_studio_tag_id})

        # ── Decide whether this scene needs any action ────────────────────────
        # A scene enters the pending list if ANY of:
        #   • filename token changes
        #   • tag changes (from tokens)
        #   • directory needs fixing (wrong_studio / self_titled / shallow)
        #   • MissingStudio tag needs adding
        needs_dir_fix = dir_class in ("wrong_studio", "self_titled", "shallow")
        if not has_token_tag_changes and not has_filename_changes \
                and not needs_dir_fix and not needs_missing_studio_tag:
            continue

        # ── Build pending entry ───────────────────────────────────────────────

        # Compute new_path (may be updated further in apply if user adjusts stem)
        if has_filename_changes or needs_dir_fix:
            if studio_folder and dir_class != "ok":
                grandparent = os.path.dirname(file_dirname)
                dest_dir    = os.path.join(grandparent, studio_folder)
            else:
                dest_dir    = file_dirname
            new_path = os.path.join(dest_dir, new_stem + ext)
        else:
            new_path = path   # no file move needed

        pending.append({
            "scene_id":              scene["id"],
            "scene_title":           scene.get("title") or basename_orig,
            "file_id":               file["id"],
            "original_path":         path,
            "new_path":              new_path,
            "original_stem":         stem,
            "new_stem":              new_stem,
            "matched_tokens":        matched,
            "unmatched_tokens":      unmatched_sigil,
            "stripped_unmatched":    strip_unmatched,
            "tags_to_add":           tags_to_add,
            "tags_already_on_scene": tags_already,
            "all_tag_ids":           all_tag_ids,
            "filename_changes":      has_filename_changes,
            "studio_name":           studio_name,
            "studio_folder":         studio_folder,
            "rename_source":         rename_source,  # "metadata" | "tokens"
            "year":                  year_meta,
            # New fields
            "dir_class":             dir_class,      # "ok"|"wrong_studio"|"self_titled"|"shallow"
            "needs_dir_fix":         needs_dir_fix,
            "needs_missing_studio":  needs_missing_studio_tag,
            "missing_studio_tag_id": missing_studio_tag_id,
        })

    report = {
        "status":        "done",
        "message":       f"Found {len(pending)} scenes needing attention.",
        "progress":      100,
        "total_scanned": len(all_scenes),
        "pending":       pending,
        "generated_at":  int(time.time()),
    }
    _write_report(report)
    _write_status({
        "status":   "done",
        "message":  f"Scan complete. {len(pending)} scenes found.",
        "progress": 100,
    })
    print(f"Scan complete. {len(pending)} scenes to sanitize.", flush=True)


# ── Apply task ────────────────────────────────────────────────────────────────

def task_apply(url, apikey, args):
    """
    Apply a subset of the pending changes.
    args["scene_ids"] = comma-separated IDs  OR  "all"
    """
    scene_ids_arg = str(args.get("scene_ids", "all")).strip()

    report_path = os.path.join(ASSETS_DIR, "sanitize_report.json")
    if not os.path.exists(report_path):
        print("No report found. Run Scan first.", flush=True)
        sys.exit(1)

    with open(report_path) as f:
        report = json.load(f)

    pending = report.get("pending", [])
    if not pending:
        print("Nothing to apply.", flush=True)
        return

    if scene_ids_arg == "all":
        to_apply = pending
    else:
        ids_set  = set(scene_ids_arg.split(","))
        to_apply = [p for p in pending if str(p["scene_id"]) in ids_set]

    print(f"Applying {len(to_apply)} changes…", flush=True)
    done, errors = 0, 0

    for item in to_apply:
        sid = item["scene_id"]
        try:
            # ── Determine effective destination path ──────────────────────────
            orig_path    = item["original_path"]
            orig_dir     = os.path.dirname(orig_path)
            ext          = os.path.splitext(os.path.basename(orig_path))[1]
            effective_stem = item["new_stem"]

            studio_folder = item.get("studio_folder")
            dir_class     = item.get("dir_class", "ok")

            if studio_folder and dir_class != "ok":
                grandparent = os.path.dirname(orig_dir)
                dest_dir    = os.path.join(grandparent, studio_folder)
            else:
                dest_dir    = orig_dir

            new_path = os.path.join(dest_dir, effective_stem + ext)

            # ── Move file if path changed ─────────────────────────────────────
            if orig_path != new_path:
                ok = move_file(url, apikey, item["file_id"], new_path)
                if not ok:
                    print(f"  WARNING: moveFiles returned false for scene {sid}", flush=True)

            # ── Update title ──────────────────────────────────────────────────
            # When the rename came from existing metadata, the scene title is
            # already correct — leave it intact. Only strip tag-tokens out of
            # the title when we derived the name from the filename tokens.
            original_title = item.get("scene_title", "")
            if item.get("rename_source") == "metadata":
                new_title = original_title
            else:
                new_title = original_title
                strip_from_title = list(item.get("matched_tokens", []))
                if item.get("stripped_unmatched"):
                    strip_from_title.extend(item.get("unmatched_tokens", []))
                # Also strip bracketed [ ... ] groups from the title.
                new_title = BRACKET_GROUP_RE.sub(' ', new_title)
                for tok in strip_from_title:
                    new_title = re.sub(re.escape(tok["raw"]), '', new_title, flags=re.IGNORECASE)
                new_title = re.sub(r'\s+', ' ', new_title).strip()
                new_title = strip_tag_affixes(new_title)
            if not new_title:
                new_title = effective_stem

            all_tag_ids = item.get("all_tag_ids", [])
            update_scene(url, apikey, sid, new_title, all_tag_ids)

            done += 1
            print(f"  ✓ Scene {sid}: {os.path.basename(orig_path)} → {os.path.basename(new_path)}", flush=True)
        except Exception as e:
            errors += 1
            print(f"  ✗ Scene {sid}: {e}", flush=True)

    applied_ids = {item["scene_id"] for item in to_apply}
    report["pending"] = [p for p in pending if p["scene_id"] not in applied_ids]
    report["last_apply"] = {
        "done":      done,
        "errors":    errors,
        "timestamp": int(time.time()),
    }
    _write_report(report)
    print(f"Apply complete: {done} done, {errors} errors.", flush=True)


def _write_status(data):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    with open(os.path.join(ASSETS_DIR, "sanitize_status.json"), "w") as f:
        json.dump(data, f)


def _write_report(data):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    with open(os.path.join(ASSETS_DIR, "sanitize_report.json"), "w") as f:
        json.dump(data, f)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    raw_stdin = sys.stdin.read()
    if not raw_stdin.strip():
        print("ERROR: stdin is empty.", flush=True)
        sys.exit(1)

    input_data        = json.loads(raw_stdin)
    server_connection = input_data.get("server_connection", {})
    scheme            = server_connection.get("Scheme", "http")
    port              = server_connection.get("Port", 9999)
    apikey            = server_connection.get("ApiKey", "")

    if not apikey:
        cookie_obj   = server_connection.get("SessionCookie", {})
        cookie_name  = cookie_obj.get("Name", "session")
        cookie_value = cookie_obj.get("Value", "")
        if cookie_value:
            global SESSION_COOKIE
            SESSION_COOKIE = f"{cookie_name}={cookie_value}"

    plugin_dir_from_stash = server_connection.get("PluginDir", "")
    if plugin_dir_from_stash:
        global PLUGIN_DIR, ASSETS_DIR
        PLUGIN_DIR = plugin_dir_from_stash
        ASSETS_DIR = os.path.join(PLUGIN_DIR, "assets")
        os.makedirs(ASSETS_DIR, exist_ok=True)

    url = f"{scheme}://localhost:{port}/graphql"

    raw_args  = input_data.get("args", {})
    task_name = raw_args.get("mode", "") if isinstance(raw_args, dict) else ""
    if not task_name:
        task_name = input_data.get("task", {}).get("name", "")

    plugin_args = raw_args if isinstance(raw_args, dict) else {}
    print(f"Task={task_name!r} PluginDir={PLUGIN_DIR!r}", flush=True)

    if task_name == "Scan for Dirty Filenames":
        task_scan(url, apikey)
    elif task_name == "Apply Sanitization":
        task_apply(url, apikey, plugin_args)
    else:
        print(f"Unknown task: {task_name!r}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()