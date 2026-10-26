import sys
import json
import urllib.request
import urllib.error
import subprocess
import os
import time

# PluginDir is provided by Stash in server_connection - we extract it after
# reading stdin. For module-level setup, derive from argv[0].
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
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as e:
        print(f"GraphQL request failed: {e}", flush=True)
        sys.exit(1)


def get_scene(url, apikey, scene_id):
    query = """
    query FindScene($id: ID!) {
      findScene(id: $id) {
        id title
        files { id path size video_codec width height bit_rate duration }
      }
    }
    """
    res = graphql_query(url, apikey, query, {"id": scene_id})
    return res.get("data", {}).get("findScene")


def ffprobe_stream(path):
    """Live-probe the first video stream. Returns a dict or None."""
    try:
        r = subprocess.run([
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_streams", "-select_streams", "v:0", path,
        ], capture_output=True, text=True)
        info = json.loads(r.stdout)
        streams = info.get("streams", [])
        if streams:
            s = streams[0]
            return {
                "codec_name": s.get("codec_name"),
                "width": s.get("width"),
                "height": s.get("height"),
                "bit_rate": s.get("bit_rate"),
                "pix_fmt": s.get("pix_fmt"),
            }
    except Exception as e:
        print(f"ffprobe failed: {e}", flush=True)
    return None


def resolution_label(width, height):
    """Human-ish resolution tag for filenames, keyed off height."""
    try:
        h = int(height or 0)
    except (TypeError, ValueError):
        h = 0
    if h >= 2160:
        return "2160p"
    if h >= 1440:
        return "1440p"
    if h >= 1080:
        return "1080p"
    if h >= 720:
        return "720p"
    if h >= 480:
        return "480p"
    return f"{h}p" if h else "unknown"


def build_output_path(input_path, width, height, codec_tag):
    """Append _<resolution>_<codec> before the extension."""
    base, ext = os.path.splitext(input_path)
    res = resolution_label(width, height)
    return f"{base}_{res}_{codec_tag}{ext}"


# Maps the UI/codec keyword to ffmpeg encoder settings and the codec tag
# we append to filenames. Keep keys lowercase.
CODEC_PROFILES = {
    "h265": {"encoder": "libx265", "tag": "h265", "extra": []},
    "hevc": {"encoder": "libx265", "tag": "h265", "extra": []},
    "h264": {"encoder": "libx264", "tag": "h264", "extra": []},
    "avc":  {"encoder": "libx264", "tag": "h264", "extra": []},
    # libaom-av1 is slow; libsvtav1 is the practical choice when available.
    "av1":  {"encoder": "libsvtav1", "tag": "av1", "extra": []},
}


def resolve_codec(target):
    """Return the CODEC_PROFILES entry for a requested target, defaulting h265."""
    return CODEC_PROFILES.get((target or "h265").lower(), CODEC_PROFILES["h265"])


def ffmpeg_transcode(input_path, output_path, extra_args=None, crf=28,
                      duration_secs=None, progress_path=None, target_codec="h265"):
    """Run ffmpeg. Writes progress JSON to progress_path if provided."""
    profile = resolve_codec(target_codec)
    # x264/x265 take named presets; SVT-AV1 takes a numeric 0-13 (8 ~ medium).
    preset = "8" if profile["encoder"] == "libsvtav1" else "medium"
    cmd = [
        "ffmpeg", "-y",
        "-progress", "pipe:1",   # write progress to stdout in key=value format
        "-nostats",               # suppress normal stats on stderr
        "-i", input_path,
        "-c:v", profile["encoder"], "-preset", preset, "-crf", str(crf),
        *profile["extra"],
        "-c:a", "copy",
    ]
    if extra_args:
        cmd.extend(extra_args)
    cmd.append(output_path)

    start = time.time()
    process = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True,
    )

    progress = {}
    def parse_progress(line):
        """Parse ffmpeg -progress key=value lines."""
        line = line.strip()
        if "=" in line:
            k, _, v = line.partition("=")
            progress[k.strip()] = v.strip()
            # ffmpeg emits a blank 'progress=continue' or 'progress=end' line
            # as a frame-complete marker — write status file then
            if k.strip() == "progress" and progress_path and duration_secs:
                out_time_us = int(progress.get("out_time_us", 0) or 0)
                out_secs = out_time_us / 1_000_000
                pct = min(100, round(out_secs / duration_secs * 100, 1)) if duration_secs else 0
                elapsed = round(time.time() - start, 1)
                eta = round((elapsed / pct * 100) - elapsed) if pct > 0 else None
                speed = progress.get("speed", "").replace("x", "")
                fps = progress.get("fps", "0")
                try:
                    with open(progress_path, "w") as pf:
                        json.dump({
                            "status": "running",
                            "pct": pct,
                            "elapsed": elapsed,
                            "eta_secs": eta,
                            "speed": speed,
                            "fps": fps,
                            "out_time_secs": round(out_secs, 1),
                            "total_secs": round(duration_secs, 1),
                        }, pf)
                except Exception:
                    pass
        if line:
            print(line, flush=True)

    import threading
    def read_stderr():
        for line in process.stderr:
            print(line.strip(), flush=True)

    t = threading.Thread(target=read_stderr, daemon=True)
    t.start()

    for line in process.stdout:
        parse_progress(line)

    process.wait()
    t.join(timeout=2)
    return process.returncode, round(time.time() - start, 1)


def extract_frame(input_path, output_filename, seek=None):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    output_path = os.path.join(ASSETS_DIR, output_filename)
    seek_args = ["-ss", str(seek)] if seek else []
    cmd = [
        "ffmpeg", "-y", *seek_args, "-i", input_path,
        "-vframes", "1", "-q:v", "3", "-vf", "scale=640:-2", output_path,
    ]
    result = subprocess.run(cmd, capture_output=True)
    return output_filename if result.returncode == 0 else None


def _write_probe_result(scene_id, data):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    out_path = os.path.join(ASSETS_DIR, f"probe_{scene_id}.json")
    with open(out_path, "w") as f:
        json.dump(data, f)
    print(f"Probe result written to {out_path}", flush=True)


def task_probe(url, apikey, args):
    """Live ffprobe on the scene's file. Reports the actual stream codec,
    which may differ from the codec Stash recorded at scan time."""
    scene_id = str(args.get("scene_id", "")).strip()
    if not scene_id:
        print("Error: No scene_id provided.", flush=True)
        sys.exit(1)

    os.makedirs(ASSETS_DIR, exist_ok=True)
    _write_probe_result(scene_id, {"scene_id": scene_id, "status": "pending"})

    scene = get_scene(url, apikey, scene_id)
    if not scene:
        _write_probe_result(scene_id, {"scene_id": scene_id, "status": "error",
                                       "error": f"Scene {scene_id} not found."})
        sys.exit(1)

    files = scene.get("files", [])
    if not files:
        _write_probe_result(scene_id, {"scene_id": scene_id, "status": "error",
                                       "error": "Scene has no files."})
        sys.exit(1)

    file = files[0]
    input_path = file["path"]
    db_codec = (file.get("video_codec") or "").lower()

    print(f"Probing {input_path}", flush=True)
    probe = ffprobe_stream(input_path)
    if not probe:
        _write_probe_result(scene_id, {
            "scene_id": scene_id, "status": "error",
            "error": "ffprobe could not read the file. Check that the path is "
                     "reachable from the Stash host.",
            "path": input_path, "db_codec": db_codec,
        })
        sys.exit(1)

    live_codec = (probe.get("codec_name") or "").lower()
    mismatch = bool(live_codec) and bool(db_codec) and live_codec != db_codec \
        and not ({live_codec, db_codec} <= {"h264", "avc"}) \
        and not ({live_codec, db_codec} <= {"h265", "hevc"})

    _write_probe_result(scene_id, {
        "scene_id": scene_id, "status": "done",
        "path": input_path,
        "db_codec": db_codec,
        "live_codec": live_codec,
        "width": probe.get("width"),
        "height": probe.get("height"),
        "bit_rate": probe.get("bit_rate"),
        "pix_fmt": probe.get("pix_fmt"),
        "mismatch": mismatch,
    })
    print(f"db_codec={db_codec} live_codec={live_codec} mismatch={mismatch}", flush=True)


def task_dry_run(url, apikey, args):
    scene_id = str(args.get("scene_id", "")).strip()
    crf = int(args.get("crf", 28))
    if not scene_id:
        print("Error: No scene_id provided.", flush=True)
        sys.exit(1)

    print(f"Dry run: fetching scene {scene_id}", flush=True)
    scene = get_scene(url, apikey, scene_id)
    if not scene:
        print(f"Error: Scene {scene_id} not found.", flush=True)
        sys.exit(1)

    files = scene.get("files", [])
    if not files:
        print("Error: Scene has no files.", flush=True)
        sys.exit(1)

    file = files[0]
    input_path = file["path"]
    codec = file.get("video_codec", "").lower()
    original_size = file.get("size", 0)
    duration = file.get("duration", 0) or 0

    print(f"Scene: {input_path} | codec={codec} | size={original_size} | duration={duration}", flush=True)

    # Write pending marker immediately so the UI knows a run is in progress
    os.makedirs(ASSETS_DIR, exist_ok=True)
    _write_dryrun_result(scene_id, {"scene_id": scene_id, "status": "pending"})

    if codec not in ("h264", "avc"):
        print(f"Not h264 (is {codec}), writing skipped result.", flush=True)
        _write_dryrun_result(scene_id, {
            "scene_id": scene_id, "status": "done",
            "original_codec": codec, "original_size": original_size,
            "estimated_size": original_size, "saving_percent": 0,
            "note": f"Not h264 (is {codec}), skipped.",
        })
        return

    sample_seek = max(0, duration * 0.1)
    sample_duration = min(30, duration)
    os.makedirs(ASSETS_DIR, exist_ok=True)
    sample_output = os.path.join(ASSETS_DIR, f"sample_{scene_id}.mp4")

    print(f"Encoding {sample_duration}s sample from {sample_seek:.1f}s into {sample_output}", flush=True)
    returncode, encode_time = ffmpeg_transcode(
        input_path, sample_output,
        extra_args=["-ss", str(sample_seek), "-t", str(sample_duration)],
        crf=crf,
        duration_secs=sample_duration,
    )

    if returncode != 0 or not os.path.exists(sample_output):
        print("Error: Sample encode failed.", flush=True)
        sys.exit(1)

    sample_size = os.path.getsize(sample_output)
    ratio = duration / sample_duration if sample_duration > 0 else 1
    estimated_size = int(sample_size * ratio)
    saving_percent = ((original_size - estimated_size) / original_size * 100) if original_size else 0

    # Get bitrates via ffprobe
    def get_bitrate_kbps(path):
        try:
            r = subprocess.run([
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_streams", "-select_streams", "v:0", path
            ], capture_output=True, text=True)
            info = json.loads(r.stdout)
            streams = info.get("streams", [])
            if streams:
                br = streams[0].get("bit_rate") or streams[0].get("avg_frame_rate")
                # bit_rate is in bps
                raw = streams[0].get("bit_rate", "0")
                return round(int(raw) / 1000) if raw and raw != "N/A" else None
        except Exception:
            pass
        return None

    src_kbps = get_bitrate_kbps(input_path)
    out_kbps = get_bitrate_kbps(sample_output)

    print(f"Original: {original_size/1024/1024:.1f} MB @ {src_kbps}kbps | Estimated: {estimated_size/1024/1024:.1f} MB @ {out_kbps}kbps | Savings: {saving_percent:.1f}%", flush=True)

    mid = duration / 2
    before_thumb = extract_frame(input_path, f"before_{scene_id}.jpg", seek=mid)
    after_thumb = extract_frame(sample_output, f"after_{scene_id}.jpg", seek=min(15, sample_duration / 2))

    _write_dryrun_result(scene_id, {
        "scene_id": scene_id, "status": "done",
        "original_codec": codec, "original_size": original_size,
        "estimated_size": estimated_size,
        "saving_percent": round(saving_percent, 2),
        "sample_encode_time": encode_time,
        "crf": crf,
        "src_kbps": src_kbps,
        "out_kbps": out_kbps,
        "before_thumb": before_thumb,
        "after_thumb": after_thumb,
    })
    print("Dry run complete.", flush=True)


def _write_dryrun_result(scene_id, data):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    out_path = os.path.join(ASSETS_DIR, f"dryrun_{scene_id}.json")
    with open(out_path, "w") as f:
        json.dump(data, f)
    print(f"Results written to {out_path}", flush=True)


def _write_transcode_status(scene_id, data):
    os.makedirs(ASSETS_DIR, exist_ok=True)
    out_path = os.path.join(ASSETS_DIR, f"transcode_{scene_id}.json")
    with open(out_path, "w") as f:
        json.dump(data, f)


def task_transcode_scene(url, apikey, args):
    scene_id = str(args.get("scene_id", "")).strip()
    crf = int(args.get("crf", 28))
    target_codec = (args.get("target_codec", "h265") or "h265").lower()
    # copy_to_new: "true" -> write a new sibling file; otherwise overwrite original.
    copy_to_new = str(args.get("copy_to_new", "true")).lower() in ("1", "true", "yes")
    # source_codec: optional override from the live probe (UI trusts probe over DB).
    source_override = (args.get("source_codec", "") or "").lower()

    if not scene_id:
        print("Error: No scene_id provided.", flush=True)
        sys.exit(1)

    scene = get_scene(url, apikey, scene_id)
    if not scene:
        print(f"Error: Scene {scene_id} not found.", flush=True)
        sys.exit(1)

    files = scene.get("files", [])
    if not files:
        print("Error: Scene has no files.", flush=True)
        sys.exit(1)

    file = files[0]
    db_codec = (file.get("video_codec") or "").lower()
    # Trust the live-probe value when the UI passes one.
    source_codec = source_override or db_codec
    input_path = file["path"]

    profile = resolve_codec(target_codec)
    target_tag = profile["tag"]

    # No-op guard: don't re-encode into the same codec family.
    same_family = (
        {source_codec, target_tag} <= {"h264", "avc"} or
        {source_codec, target_tag} <= {"h265", "hevc"} or
        (source_codec == "av1" and target_tag == "av1")
    )
    if same_family:
        msg = f"Source is already {source_codec}; target {target_tag} is the same codec. Skipping."
        print(msg, flush=True)
        _write_transcode_status(scene_id, {"scene_id": scene_id, "status": "done",
                                           "note": msg, "output": input_path})
        return

    # Probe live dimensions for the filename; fall back to DB width/height.
    probe = ffprobe_stream(input_path) or {}
    width = probe.get("width") or file.get("width")
    height = probe.get("height") or file.get("height")

    progress_path = os.path.join(ASSETS_DIR, f"progress_{scene_id}.json")
    duration_secs = file.get("duration") or 0

    if copy_to_new:
        # New sibling file: name_<res>_<codec>.ext
        output_path = build_output_path(input_path, width, height, target_tag)
        if os.path.exists(output_path):
            print(f"Output already exists: {output_path}", flush=True)
            _write_transcode_status(scene_id, {"scene_id": scene_id, "status": "done",
                                               "note": "already existed", "output": output_path})
            return
        encode_target = output_path
        final_path = output_path
        replace_original = False
    else:
        # Overwrite mode: encode to a temp file alongside the original, then move
        # it onto the original path. Keeping the path identical lets Stash keep
        # the same file record (re-fingerprinting aside) after a rescan.
        _, ext = os.path.splitext(input_path)
        encode_target = input_path + f".mrst_tmp{ext}"
        final_path = input_path
        replace_original = True
        if os.path.exists(encode_target):
            try:
                os.remove(encode_target)
            except OSError:
                pass

    _write_transcode_status(scene_id, {
        "scene_id": scene_id, "status": "running",
        "input": input_path, "output": final_path,
        "crf": crf, "target_codec": target_tag,
        "copy_to_new": copy_to_new,
    })
    print(f"Transcoding scene {scene_id}: {input_path} -> {final_path} "
          f"[{source_codec}->{target_tag}] CRF={crf} copy_to_new={copy_to_new} "
          f"duration={duration_secs}s", flush=True)

    returncode, elapsed = ffmpeg_transcode(
        input_path, encode_target, crf=crf,
        duration_secs=duration_secs, progress_path=progress_path,
        target_codec=target_codec,
    )

    if returncode != 0 or not os.path.exists(encode_target):
        _write_transcode_status(scene_id, {"scene_id": scene_id, "status": "error"})
        print(f"Error transcoding scene {scene_id}.", flush=True)
        # Clean up a partial temp file so we don't leave junk next to the original.
        if replace_original and os.path.exists(encode_target):
            try:
                os.remove(encode_target)
            except OSError:
                pass
        sys.exit(1)

    if replace_original:
        try:
            # os.replace is atomic on the same filesystem and overwrites the dest.
            os.replace(encode_target, final_path)
            print(f"Replaced original in place: {final_path}", flush=True)
        except OSError as e:
            _write_transcode_status(scene_id, {"scene_id": scene_id, "status": "error",
                                               "error": f"Failed to replace original: {e}"})
            print(f"Error replacing original: {e}", flush=True)
            sys.exit(1)

    output_size = os.path.getsize(final_path) if os.path.exists(final_path) else 0
    _write_transcode_status(scene_id, {
        "scene_id": scene_id, "status": "done",
        "input": input_path, "output": final_path,
        "crf": crf, "elapsed": elapsed, "output_size": output_size,
        "target_codec": target_tag, "copy_to_new": copy_to_new,
        "replaced_original": replace_original,
    })
    print(f"Done in {elapsed}s: {final_path}", flush=True)
    if replace_original:
        print("Rescan this scene so Stash refreshes the file metadata.", flush=True)
    else:
        print("Run a library scan to pick up the new file.", flush=True)


def task_batch_transcode(url, apikey, plugins_config):
    my_config = plugins_config.get("MRStashTranscode", {})
    target_tag = my_config.get("target_tag", "").strip()

    if not target_tag:
        print("Error: No target tag configured. Set it in Settings → Plugins.", flush=True)
        sys.exit(1)

    print(f"Batch transcode for tag: '{target_tag}'", flush=True)

    tag_res = graphql_query(url, apikey, """
    query FindTags($name: String!) {
      findTags(filter: {q: $name}) { tags { id name } }
    }
    """, {"name": target_tag})
    tags = tag_res.get("data", {}).get("findTags", {}).get("tags", [])
    target_tag_id = next((t["id"] for t in tags if t["name"].lower() == target_tag.lower()), None)

    if not target_tag_id:
        print(f"Error: Tag '{target_tag}' not found.", flush=True)
        sys.exit(1)

    scenes_res = graphql_query(url, apikey, """
    query FindScenes($tag_id: ID!) {
      findScenes(filter: {per_page: -1}, scene_filter: {tags: {value: [$tag_id], modifier: INCLUDES}}) {
        scenes { id files { id path video_codec } }
      }
    }
    """, {"tag_id": target_tag_id})
    scenes = scenes_res.get("data", {}).get("findScenes", {}).get("scenes", [])

    if not scenes:
        print("No scenes found with this tag.", flush=True)
        return

    for scene in scenes:
        for file in scene.get("files", []):
            codec = file.get("video_codec", "").lower()
            if codec not in ("h264", "avc"):
                print(f"Skipping {file['path']} (codec: {codec})", flush=True)
                continue
            input_path = file["path"]
            base, ext = os.path.splitext(input_path)
            output_path = f"{base}_h265{ext}"
            if os.path.exists(output_path):
                print(f"Skipping — output exists: {output_path}", flush=True)
                continue
            print(f"--- Transcoding: {input_path} ---", flush=True)
            returncode, elapsed = ffmpeg_transcode(input_path, output_path)
            if returncode == 0:
                print(f"Done in {elapsed}s: {output_path}", flush=True)
            else:
                print(f"Error on: {input_path}", flush=True)

    print("Batch complete. Run a library scan to pick up new files.", flush=True)


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

    # If no ApiKey, fall back to session cookie for auth
    session_cookie = None
    if not apikey:
        cookie_obj = server_connection.get("SessionCookie", {})
        cookie_name = cookie_obj.get("Name", "session")
        cookie_value = cookie_obj.get("Value", "")
        if cookie_value:
            session_cookie = f"{cookie_name}={cookie_value}"

    # Use PluginDir from server_connection if available (Stash always sends it)
    plugin_dir_from_stash = server_connection.get("PluginDir", "")
    if plugin_dir_from_stash:
        global PLUGIN_DIR, ASSETS_DIR
        PLUGIN_DIR = plugin_dir_from_stash
        ASSETS_DIR = os.path.join(PLUGIN_DIR, "assets")
        os.makedirs(ASSETS_DIR, exist_ok=True)

    # Set module-level auth so all graphql_query calls use it
    global SESSION_COOKIE
    SESSION_COOKIE = session_cookie

    url = f"{scheme}://localhost:{port}/graphql"

    raw_args = input_data.get("args", {})
    task_name = raw_args.get("mode", "") if isinstance(raw_args, dict) else ""
    if not task_name:
        task_name = input_data.get("task", {}).get("name", "")

    plugin_args = raw_args if isinstance(raw_args, dict) else {}

    print(f"Task={task_name!r} PluginDir={PLUGIN_DIR!r}", flush=True)

    if task_name == "Dry Run":
        task_dry_run(url, apikey, plugin_args)
    elif task_name == "Probe":
        task_probe(url, apikey, plugin_args)
    elif task_name == "Transcode Scene":
        task_transcode_scene(url, apikey, plugin_args)
    elif task_name == "Batch Transcode Tag to H265":
        config_res = graphql_query(url, apikey, "query { configuration { plugins } }")
        plugins_config = config_res.get("data", {}).get("configuration", {}).get("plugins", {})
        task_batch_transcode(url, apikey, plugins_config)
    else:
        print(f"Unknown task: {task_name!r}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()