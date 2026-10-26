(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  const React = window.React || PluginApi.React;
  const ReactDOM = window.ReactDOM || PluginApi.ReactDOM;
  const { useState, useEffect, useRef } = React;
  const ce = React.createElement;

  const LOG = (...a) => console.log("[MRStashDupManager]", ...a);
  const WARN = (...a) => console.warn("[MRStashDupManager]", ...a);

  LOG("Plugin loaded");

  const PLUGIN_ID = "MRStashDupManager";
  const EXCLUDE_TAG_NAME = "_DuplicateExclude";

  // ── Matching presets (mirror Stash's native Scene Duplicate Checker) ──────────
  // Search accuracy dropdown -> phash distance is resolved server-side; here we
  // only need the labels to send as args and to display.
  const ACCURACY_OPTIONS = [
    { value: "exact", label: "Exact" },
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
    { value: "loose", label: "Loose" },
  ];
  const DURATION_OPTIONS = [
    { value: "any", label: "Any" },
    { value: "equal", label: "Equal" },
    { value: "1", label: "1 sec" },
    { value: "5", label: "5 sec" },
    { value: "10", label: "10 sec" },
  ];
  const DEFAULT_ACCURACY = "exact";
  const DEFAULT_DURATION = "1";

  // ── Filename-length safeguards ────────────────────────────────────────────────
  // Stash's soft-delete step renames "<name>" -> "<name>.delete" before removing
  // it. If the basename is already near the FS per-component byte limit, that
  // rename fails with ENAMETOOLONG. We detect it and rename the file shorter first.
  const DELETE_SUFFIX = ".delete";
  const MAX_NAME_BYTES = 255; // ext4/xfs/apfs; lower for SMB/CIFS/eCryptfs shares

  function byteLength(s) {
    return new TextEncoder().encode(s).length;
  }

  function deleteWouldOverflow(path) {
    return byteLength(basename(path)) + byteLength(DELETE_SUFFIX) > MAX_NAME_BYTES;
  }

  function shortenBasename(name, budget) {
    budget = budget || MAX_NAME_BYTES - byteLength(DELETE_SUFFIX);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot) : "";
    const stem = dot > 0 ? name.slice(0, dot) : name;

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const room = budget - byteLength(ext) - 5; // headroom for a uniquifier
    let bytes = enc.encode(stem);
    if (bytes.length <= room) return name;

    bytes = bytes.slice(0, room);
    const trimmedStem = dec.decode(bytes).replace(/\uFFFD+$/, ""); // drop partial char
    const tag = Math.random().toString(36).slice(2, 6);
    return `${trimmedStem}_${tag}${ext}`;
  }

  // ── GraphQL ──────────────────────────────────────────────────────────────────
  async function gqlQuery(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  }

  async function runPluginTask(taskName, args) {
    await gqlQuery(
      `mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args: [PluginArgInput!]) {
        runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args: $args)
      }`,
      { plugin_id: PLUGIN_ID, task_name: taskName, args: args || [] }
    );
  }

  async function destroyScene(sceneId, deleteFile) {
    return gqlQuery(
      `mutation SceneDestroy($input: SceneDestroyInput!) {
        sceneDestroy(input: $input)
      }`,
      {
        input: {
          id: sceneId,
          delete_file: !!deleteFile,
          delete_generated: true,
        },
      }
    );
  }

  async function renameFileBasename(fileId, currentFolder, newBasename) {
    // Rename in place: moveFiles REQUIRES a destination folder even when only
    // the basename changes ("must specify destination folder or path"), so we
    // pass the file's existing folder to keep it in the same directory.
    return gqlQuery(
      `mutation MoveFiles($input: MoveFilesInput!) {
        moveFiles(input: $input)
      }`,
      {
        input: {
          ids: [fileId],
          destination_folder: currentFolder,
          destination_basename: newBasename,
        },
      }
    );
  }

  async function ensureExcludeTag() {
    const data = await gqlQuery(`query { allTags { id name } }`);
    const found = (data.allTags || []).find(
      (t) => t.name.toLowerCase() === EXCLUDE_TAG_NAME.toLowerCase()
    );
    if (found) return found;
    const created = await gqlQuery(
      `mutation TagCreate($input: TagCreateInput!) {
        tagCreate(input: $input) { id name }
      }`,
      { input: { name: EXCLUDE_TAG_NAME } }
    );
    return created.tagCreate;
  }

  async function addTagToScene(sceneId, existingTagIds, tagId) {
    if (existingTagIds.includes(tagId)) return;
    await gqlQuery(
      `mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) { id }
      }`,
      { input: { id: sceneId, tag_ids: [...existingTagIds, tagId] } }
    );
  }

  async function mergeMetadata(keeper, loser) {
    // Union tags and performers from loser onto keeper.
    const tagIds = [
      ...new Set([
        ...keeper.tags.map((t) => t.id),
        ...loser.tags.map((t) => t.id),
      ]),
    ];
    const perfIds = [
      ...new Set([
        ...keeper.performers.map((p) => p.id),
        ...loser.performers.map((p) => p.id),
      ]),
    ];
    const input = { id: keeper.scene_id, tag_ids: tagIds, performer_ids: perfIds };
    if ((keeper.rating100 == null) && loser.rating100 != null) {
      input.rating100 = loser.rating100;
    }
    await gqlQuery(
      `mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) { id }
      }`,
      { input }
    );
  }

  // Delete a scene's file, shortening the basename first if Stash's ".delete"
  // rename would overflow the filesystem name limit.
  async function deleteSceneFileSafely(member) {
    if (member.file_id && deleteWouldOverflow(member.path)) {
      const folder = dirname(member.path);
      const shortName = shortenBasename(basename(member.path));
      LOG("Filename too long for soft-delete; renaming first:", basename(member.path), "→", shortName, "in", folder);
      await renameFileBasename(member.file_id, folder, shortName);
    }
    await destroyScene(member.scene_id, true);
  }

  // ── Asset polling ─────────────────────────────────────────────────────────────

  async function fetchAssetJSON(filename) {
    const res = await fetch(`/plugin/${PLUGIN_ID}/assets/${filename}?t=${Date.now()}`);
    if (!res.ok) return null;
    return res.json();
  }

  function pollUntilDone(filename, onUpdate, onDone, onError, intervalMs, maxMs) {
    const start = Date.now();
    const limit = maxMs || 600_000;
    const iv = setInterval(async () => {
      if (Date.now() - start > limit) {
        clearInterval(iv);
        onError("Timed out waiting for the scan task.");
        return;
      }
      try {
        const data = await fetchAssetJSON(filename);
        if (!data) return;
        onUpdate(data);
        if (data.status === "done" || data.status === "error") {
          clearInterval(iv);
          if (data.status === "done") onDone(data);
          else onError(data.message || "Task failed.");
        }
      } catch (_) {}
    }, intervalMs || 700);
    return () => clearInterval(iv);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function basename(p) {
    return (p || "").split(/[\\/]/).pop();
  }

  function dirname(p) {
    const s = (p || "").replace(/[\\/]+$/, "");
    const i = s.search(/[\\/][^\\/]*$/);
    return i >= 0 ? s.slice(0, i) : "";
  }

  function fmtBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

  function fmtDuration(sec) {
    if (!sec) return "0:00";
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    return `${m}:${String(ss).padStart(2, "0")}`;
  }

  function resolutionLabel(m) {
    if (!m.height) return "?";
    return `${m.width}×${m.height}`;
  }

  const RANK_LABEL = {
    0: { label: "Whitelist", color: "#66bb6a" },
    1: { label: "Neutral", color: "#90a4ae" },
    2: { label: "Gray-list", color: "#ffb74d" },
    3: { label: "Blacklist", color: "#ef5350" },
  };

  // ── Icons ─────────────────────────────────────────────────────────────────────

  const IconScan = () => ce("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, ce("circle", { cx: 11, cy: 11, r: 8 }), ce("line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }));
  const IconCheck = () => ce("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round" }, ce("polyline", { points: "20 6 9 17 4 12" }));
  const IconX = () => ce("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round" }, ce("line", { x1: 18, y1: 6, x2: 6, y2: 18 }), ce("line", { x1: 6, y1: 6, x2: 18, y2: 18 }));
  const IconTrash = () => ce("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, ce("polyline", { points: "3 6 5 6 21 6" }), ce("path", { d: "M19 6l-1 14H6L5 6" }), ce("path", { d: "M10 11v6M14 11v6" }), ce("path", { d: "M9 6V4h6v2" }));
  const IconRemove = () => ce("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, ce("path", { d: "M22 12H2" }), ce("path", { d: "M5 12V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6" }));
  const IconStar = () => ce("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 13, height: 13, fill: "currentColor", stroke: "none" }, ce("polygon", { points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" }));
  const IconMerge = () => ce("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 13, height: 13, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, ce("path", { d: "M8 3v3a2 2 0 0 1-2 2H3" }), ce("path", { d: "M8 21v-3a2 2 0 0 0-2-2H3" }), ce("path", { d: "M21 12H8" }), ce("polyline", { points: "16 7 21 12 16 17" }));
  const IconLink = () => ce("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 12, height: 12, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, ce("path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }), ce("path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }));
  const IconWarn = () => ce("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 12, height: 12, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, ce("path", { d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" }), ce("line", { x1: 12, y1: 9, x2: 12, y2: 13 }), ce("line", { x1: 12, y1: 17, x2: 12.01, y2: 17 }));

  // ── Sprite grid ────────────────────────────────────────────────────────────────
  // Stash generates a "_sprite.jpg" per scene: a single image holding a grid of
  // thumbnails sampled across the scene's duration (the same asset the scrubber
  // preview uses). We render it as-is — it's already a grid, so it gives the
  // at-a-glance "is this the same video" comparison the native duplicate checker
  // shows. If the sprite hasn't been generated yet the <img> 404s, so we hide it
  // on error rather than showing a broken-image icon.

  function SpriteGrid({ member }) {
    const [failed, setFailed] = useState(false);

    // Prefer the sprite (grid of frames); fall back to the single screenshot.
    const src = member.sprite || member.screenshot;
    if (!src || failed) return null;

    const isSprite = !!member.sprite;
    return ce("div", { className: "dm-sprite-wrap" },
      ce("img", {
        className: "dm-sprite" + (isSprite ? "" : " dm-sprite-single"),
        src,
        loading: "lazy",
        alt: isSprite ? "frame grid" : "cover frame",
        title: isSprite ? "Sampled frames across the scene" : "Cover frame",
        onError: () => setFailed(true),
      })
    );
  }

  // ── Scene card ─────────────────────────────────────────────────────────────────

  function StatBadge({ label, value, highlight }) {
    return ce("div", { className: `dm-stat ${highlight ? "dm-stat-best" : ""}` },
      ce("span", { className: "dm-stat-label" }, label),
      ce("span", { className: "dm-stat-value" }, value)
    );
  }

  function SceneCard({ member, isKeeper, group, onMakeKeeper }) {
    const rankInfo = RANK_LABEL[member.path_rank] || RANK_LABEL[1];
    const sceneUrl = `/scenes/${member.scene_id}`;

    // Determine which stats are "best in group" for subtle highlighting
    const maxRes = Math.max(...group.members.map((m) => m.resolution));
    const maxDur = Math.max(...group.members.map((m) => Math.round(m.duration)));
    const maxSize = Math.max(...group.members.map((m) => m.size));

    // Prefer the server-computed flag, but fall back to a client check.
    const longName = member.delete_risk != null ? member.delete_risk : deleteWouldOverflow(member.path);

    return ce("div", { className: `dm-card ${isKeeper ? "dm-card-keep" : "dm-card-delete"}` },
      ce("div", { className: "dm-card-header" },
        isKeeper
          ? ce("span", { className: "dm-keeper-badge" }, ce(IconStar), " KEEP")
          : ce("button", {
              className: "dm-make-keeper-btn",
              title: "Keep this copy instead",
              onClick: () => onMakeKeeper(member.scene_id),
            }, ce(IconStar), " Keep this"),
        ce("span", {
          className: "dm-rank-badge",
          style: { color: rankInfo.color, borderColor: rankInfo.color + "66", background: rankInfo.color + "18" },
        }, rankInfo.label)
      ),

      ce("div", { className: "dm-card-title" },
        ce("a", { href: sceneUrl, target: "_blank", rel: "noreferrer", title: "Open scene in new tab" },
          member.title, " ", ce(IconLink)
        ),
        ce("span", { className: "dm-scene-id" }, `#${member.scene_id}`)
      ),

      ce("code", { className: "dm-card-path", title: member.path }, member.path),

      ce(SpriteGrid, { member }),

      ce("div", { className: "dm-card-stats" },
        ce(StatBadge, { label: "Resolution", value: resolutionLabel(member), highlight: member.resolution === maxRes && maxRes > 0 }),
        ce(StatBadge, { label: "Duration", value: fmtDuration(member.duration), highlight: Math.round(member.duration) === maxDur && maxDur > 0 }),
        ce(StatBadge, { label: "Size", value: fmtBytes(member.size), highlight: member.size === maxSize && maxSize > 0 }),
        member.bit_rate ? ce(StatBadge, { label: "Bitrate", value: `${(member.bit_rate / 1_000_000).toFixed(1)} Mbps` }) : null,
        member.video_codec ? ce(StatBadge, { label: "Codec", value: member.video_codec }) : null
      ),

      ce("div", { className: "dm-card-meta" },
        member.studio && ce("span", { className: "dm-meta-chip" }, member.studio),
        member.organized && ce("span", { className: "dm-meta-chip dm-meta-organized" }, ce(IconCheck), " Organized"),
        member.rating100 != null && ce("span", { className: "dm-meta-chip" }, `★ ${Math.round(member.rating100 / 20 * 10) / 10}`),
        member.performers.slice(0, 3).map((p) =>
          ce("span", { key: p.id, className: "dm-meta-chip dm-meta-perf" }, p.name)
        ),
        member.performers.length > 3 && ce("span", { className: "dm-meta-chip" }, `+${member.performers.length - 3}`)
      ),

      !isKeeper && longName &&
        ce("div", { className: "dm-longname-warn", title: "Filename is near the OS length limit; the plugin will rename it shorter before deletion." },
          ce(IconWarn), " long filename — will shorten before delete"
        ),

      !isKeeper && member.reasons && member.reasons.length > 0 &&
        ce("div", { className: "dm-reasons" },
          member.reasons.map((r, i) => ce("span", { key: i, className: "dm-reason-chip" }, r))
        )
    );
  }

  // ── Duplicate group ─────────────────────────────────────────────────────────────

  function GroupBlock({ group, onMakeKeeper, onAction, busy }) {
    const keeper = group.members.find((m) => m.is_keeper);
    const losers = group.members.filter((m) => !m.is_keeper);
    const reclaimable = losers.reduce((s, m) => s + m.size, 0);

    // How was this group flagged? phash / stash_id / both. A stash-id-only group
    // has no perceptual-hash confirmation, so we badge it distinctly to prompt a
    // visual check against the frame grid before deleting.
    const mt = group.match_types || ["phash"];
    const hasPhash = mt.includes("phash");
    const hasStashId = mt.includes("stash_id");
    let matchLabel, matchClass;
    if (hasPhash && hasStashId) {
      matchLabel = "phash + stash-id";
      matchClass = "dm-match-both";
    } else if (hasStashId) {
      matchLabel = "stash-id only";
      matchClass = "dm-match-stashid";
    } else {
      matchLabel = "phash";
      matchClass = "dm-match-phash";
    }

    return ce("div", { className: "dm-group" },
      ce("div", { className: "dm-group-header" },
        ce("div", { className: "dm-group-header-left" },
          ce("span", { className: "dm-group-title" }, `Duplicate group · ${group.members.length} copies`),
          ce("span", {
            className: `dm-match-badge ${matchClass}`,
            title: hasStashId && !hasPhash
              ? "Matched only by shared stash-box id — phashes differ. Confirm visually with the frame grid before deleting."
              : hasPhash && hasStashId
              ? "Matched by both perceptual hash and shared stash-box id."
              : "Matched by perceptual hash.",
          }, matchLabel)
        ),
        ce("span", { className: "dm-group-reclaim" }, `${fmtBytes(reclaimable)} reclaimable`)
      ),

      ce("div", { className: "dm-group-body" },
        // Keeper column
        keeper && ce(SceneCard, { member: keeper, isKeeper: true, group, onMakeKeeper }),

        // Losers
        ce("div", { className: "dm-losers" },
          losers.map((m) =>
            ce("div", { className: "dm-loser-wrap", key: m.scene_id },
              ce(SceneCard, { member: m, isKeeper: false, group, onMakeKeeper }),
              ce("div", { className: "dm-loser-actions" },
                ce("button", {
                  className: "dm-btn dm-btn-danger",
                  disabled: busy,
                  title: "Delete file from disk and remove scene from Stash",
                  onClick: () => onAction(group, m, "delete"),
                }, ce(IconTrash), " Delete file"),
                ce("button", {
                  className: "dm-btn dm-btn-warn",
                  disabled: busy,
                  title: "Remove scene from Stash library only — leaves the file on disk",
                  onClick: () => onAction(group, m, "remove"),
                }, ce(IconRemove), " Remove from Stash"),
                ce("button", {
                  className: "dm-btn dm-btn-ghost",
                  disabled: busy,
                  title: "Merge tags & performers into the kept scene, then delete this file",
                  onClick: () => onAction(group, m, "merge_delete"),
                }, ce(IconMerge), " Merge → delete"),
                ce("button", {
                  className: "dm-btn dm-btn-ghost",
                  disabled: busy,
                  title: `Tag this scene ${EXCLUDE_TAG_NAME} and skip it`,
                  onClick: () => onAction(group, m, "exclude"),
                }, ce(IconX), " Exclude")
              )
            )
          )
        )
      )
    );
  }

  // ── Main Modal ──────────────────────────────────────────────────────────────────

  function DupModal({ onClose }) {
    const [phase, setPhase] = useState("idle");
    const [scanStatus, setScanStatus] = useState(null);
    const [report, setReport] = useState(null);
    const [errorMsg, setErrorMsg] = useState("");
    const [actionMsg, setActionMsg] = useState("");
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState("");
    const [accuracy, setAccuracy] = useState(DEFAULT_ACCURACY);
    const [duration, setDuration] = useState(DEFAULT_DURATION);
    const [keeperOverrides, setKeeperOverrides] = useState({}); // group_id -> scene_id
    const cancelRef = useRef(null);

    useEffect(() => {
      document.body.style.overflow = "hidden";
      fetchAssetJSON("dup_report.json")
        .then((data) => {
          if (data && data.status === "done" && (data.groups || []).length > 0) {
            setReport(data);
            setPhase("review");
            // Reflect the criteria the existing report was built with, if present.
            if (data.settings && data.settings.accuracy) setAccuracy(data.settings.accuracy);
            if (data.settings && data.settings.duration) setDuration(data.settings.duration);
          }
        })
        .catch(() => {});
      return () => {
        document.body.style.overflow = "";
        if (cancelRef.current) cancelRef.current();
      };
    }, []);

    async function handleScan() {
      if (cancelRef.current) cancelRef.current();
      setPhase("scanning");
      setScanStatus({ status: "running", message: "Starting scan…", progress: 0 });
      setReport(null);
      setErrorMsg("");
      setActionMsg("");
      setKeeperOverrides({});

      try {
        await runPluginTask("Scan for Duplicates", [
          { key: "mode", value: { str: "Scan for Duplicates" } },
          { key: "accuracy", value: { str: accuracy } },
          { key: "duration", value: { str: duration } },
        ]);
      } catch (e) {
        setPhase("error");
        setErrorMsg("Failed to start scan: " + e.message);
        return;
      }

      cancelRef.current = pollUntilDone(
        "dup_status.json",
        (data) => setScanStatus(data),
        async () => {
          const r = await fetchAssetJSON("dup_report.json");
          if (r) setReport(r);
          setPhase("review");
        },
        (err) => {
          setPhase("error");
          setErrorMsg(err);
        },
        700,
        600_000
      );
    }

    // Apply keeper overrides on top of the report's default designation
    function effectiveGroups() {
      if (!report) return [];
      return (report.groups || []).map((g) => {
        const overrideId = keeperOverrides[g.group_id];
        if (!overrideId) return g;
        return {
          ...g,
          keeper_scene_id: overrideId,
          members: g.members.map((m) => ({ ...m, is_keeper: m.scene_id === overrideId })),
        };
      });
    }

    function handleMakeKeeper(groupId, sceneId) {
      setKeeperOverrides((prev) => ({ ...prev, [groupId]: sceneId }));
    }

    async function handleAction(group, member, kind) {
      setBusy(true);
      setErrorMsg("");
      setActionMsg("");
      try {
        if (kind === "exclude") {
          const tag = await ensureExcludeTag();
          await addTagToScene(member.scene_id, member.tags.map((t) => t.id), tag.id);
        } else if (kind === "remove") {
          await destroyScene(member.scene_id, false);
        } else if (kind === "delete") {
          await deleteSceneFileSafely(member);
        } else if (kind === "merge_delete") {
          const keeper = group.members.find((m) => m.is_keeper);
          // Delete the file FIRST (the step that can fail on name length), then
          // merge metadata — so a failure never leaves the keeper half-merged
          // against a file that's still present.
          await deleteSceneFileSafely(member);
          if (keeper) await mergeMetadata(keeper, member);
        }

        // Remove this member from the group in local state
        setReport((prev) => {
          if (!prev) return prev;
          const groups = (prev.groups || [])
            .map((g) => {
              if (g.group_id !== group.group_id) return g;
              const members = g.members.filter((m) => m.scene_id !== member.scene_id);
              return { ...g, members };
            })
            // Drop groups that no longer have at least 2 members
            .filter((g) => g.members.length >= 2);
          return { ...prev, groups };
        });

        const verb = {
          delete: "Deleted file",
          remove: "Removed from Stash",
          merge_delete: "Merged & deleted",
          exclude: "Excluded",
        }[kind];
        setActionMsg(`${verb}: ${basename(member.path)}`);
      } catch (e) {
        WARN("Action failed", kind, e);
        let msg = e.message || String(e);
        if (/file name too long|too long/i.test(msg)) {
          msg = "Filename too long for Stash's delete step. The plugin tried to " +
            "rename it shorter first — if this persists, the folder path itself may " +
            "be over the limit, or the share (SMB/NFS/encrypted) has a stricter cap " +
            "than 255 bytes.";
        }
        setErrorMsg(`${kind} failed: ${msg}`);
      } finally {
        setBusy(false);
      }
    }

    const groups = effectiveGroups();
    const filtered = groups.filter((g) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return g.members.some(
        (m) => (m.title + " " + (m.details || "") + " " + m.path).toLowerCase().includes(q)
      );
    });

    const totalReclaim = filtered.reduce(
      (s, g) => s + g.members.filter((m) => !m.is_keeper).reduce((a, m) => a + m.size, 0),
      0
    );

    return ce("div", { className: "dm-overlay", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
      ce("div", { className: "dm-modal" },

        // Header
        ce("div", { className: "dm-modal-header" },
          ce("div", { className: "dm-header-left" },
            ce("h2", null, "Duplicate File Manager"),
            ce("p", { className: "dm-subtitle" },
              "Detect duplicate scenes by perceptual hash, then keep the best copy and delete or remove the rest."
            )
          ),
          ce("button", { className: "dm-close-btn", onClick: onClose }, ce(IconX))
        ),

        // Scan bar
        ce("div", { className: "dm-scan-bar" },
          ce("button", {
            className: "dm-btn dm-btn-primary",
            onClick: handleScan,
            disabled: phase === "scanning" || busy,
          }, ce(IconScan), " ", phase === "scanning" ? "Scanning…" : "Scan for Duplicates"),

          // Matching criteria controls
          ce("div", { className: "dm-criteria" },
            ce("label", { className: "dm-criteria-field" },
              ce("span", { className: "dm-criteria-label" }, "Search accuracy"),
              ce("select", {
                className: "dm-select",
                value: accuracy,
                disabled: phase === "scanning" || busy,
                onChange: (e) => setAccuracy(e.target.value),
                title: "phash similarity: Exact=0, High=3, Medium=6, Low=8, Loose=12 (higher = looser matching, more false positives)",
              }, ACCURACY_OPTIONS.map((o) => ce("option", { key: o.value, value: o.value }, o.label)))
            ),
            ce("label", { className: "dm-criteria-field" },
              ce("span", { className: "dm-criteria-label" }, "Duration"),
              ce("select", {
                className: "dm-select",
                value: duration,
                disabled: phase === "scanning" || busy,
                onChange: (e) => setDuration(e.target.value),
                title: "Only match scenes whose durations are within this window. 'Any' disables the duration filter.",
              }, DURATION_OPTIONS.map((o) => ce("option", { key: o.value, value: o.value }, o.label)))
            )
          ),

          scanStatus && phase === "scanning" && ce("div", { className: "dm-scan-progress" },
            ce("div", { className: "dm-progress-track" },
              ce("div", { className: "dm-progress-fill", style: { width: (scanStatus.progress || 2) + "%" } })
            ),
            ce("span", { className: "dm-scan-msg" }, scanStatus.message)
          ),

          report && phase !== "scanning" && ce("div", { className: "dm-scan-summary" },
            ce("span", { className: "dm-stat-inline" },
              ce("strong", null, filtered.length), " duplicate groups"
            ),
            ce("span", { className: "dm-stat-muted" }, `${fmtBytes(totalReclaim)} reclaimable`)
          )
        ),

        errorMsg && ce("div", { className: "dm-error-bar" }, errorMsg),
        actionMsg && ce("div", { className: "dm-success-bar" }, actionMsg),

        // Review
        phase === "review" && report && ce("div", { className: "dm-review-section" },
          ce("div", { className: "dm-toolbar" },
            ce("input", {
              className: "dm-search",
              type: "text",
              placeholder: "Search title, details or path…",
              value: search,
              onChange: (e) => setSearch(e.target.value),
            })
          ),

          filtered.length === 0
            ? ce("div", { className: "dm-empty-state" }, "✓ No duplicate groups to review.")
            : ce("div", { className: "dm-group-list" },
                filtered.map((g) =>
                  ce(GroupBlock, {
                    key: g.group_id,
                    group: g,
                    busy,
                    onMakeKeeper: (sceneId) => handleMakeKeeper(g.group_id, sceneId),
                    onAction: handleAction,
                  })
                )
              )
        ),

        phase === "idle" && ce("div", { className: "dm-empty-state" },
          "Choose your matching criteria above, then click ", ce("strong", null, "Scan for Duplicates"), ". ",
          ce("span", { className: "dm-hint" },
            "Tip: run Stash's ‘Generate Phashes’ task first if you haven't already. " +
            "Generate ‘Sprites’ too if you want the frame-grid previews to show. " +
            "Widen ‘Search accuracy’ (try ‘Loose’) or set Duration to ‘Any’ if a known duplicate isn't showing up. " +
            "Scenes matched to the same StashDB scene are also grouped automatically, even when their phashes differ."
          )
        ),

        phase === "error" && ce("div", { className: "dm-empty-state dm-empty-error" },
          errorMsg || "Something went wrong."
        )
      )
    );
  }

  // ── Mount / unmount ───────────────────────────────────────────────────────────

  let _modalRoot = null;

  function openModal() {
    if (!_modalRoot) {
      _modalRoot = document.createElement("div");
      _modalRoot.id = "dm-modal-root";
      document.body.appendChild(_modalRoot);
    }
    ReactDOM.render(ce(DupModal, { onClose: closeModal }), _modalRoot);
  }

  function closeModal() {
    if (_modalRoot) ReactDOM.unmountComponentAtNode(_modalRoot);
  }

  // ── Nav button injection ──────────────────────────────────────────────────────

  function injectNavButton() {
    if (document.getElementById("dm-nav-btn")) return;
    const navbar = document.querySelector(".navbar") || document.querySelector("nav");
    if (!navbar) return;
    const target =
      navbar.querySelector(".navbar-buttons") ||
      navbar.querySelector(".ml-auto.navbar-nav") ||
      navbar.querySelector(".navbar-nav:last-child") ||
      navbar;

    const btn = document.createElement("button");
    btn.id = "dm-nav-btn";
    btn.title = "Duplicate File Manager";
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>`;
    btn.style.cssText = [
      "background:transparent", "border:none", "color:#aaa", "cursor:pointer",
      "padding:6px", "display:inline-flex", "align-items:center",
      "justify-content:center", "border-radius:4px", "line-height:1",
    ].join(";");
    btn.addEventListener("click", openModal);
    btn.addEventListener("mouseenter", () => { btn.style.color = "#4fc3f7"; });
    btn.addEventListener("mouseleave", () => { btn.style.color = "#aaa"; });
    target.insertBefore(btn, target.firstChild);
    LOG("Nav button injected");
  }

  setTimeout(injectNavButton, 800);
  PluginApi.Event.addEventListener("stash:location", () => setTimeout(injectNavButton, 300));
})();