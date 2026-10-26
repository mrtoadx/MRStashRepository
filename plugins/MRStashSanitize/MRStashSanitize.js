(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  const React = window.React || PluginApi.React;
  const ReactDOM = window.ReactDOM || PluginApi.ReactDOM;
  const { useState, useEffect, useRef, useCallback } = React;
  const ce = React.createElement;

  const LOG  = (...a) => console.log("[MRStashSanitize]",  ...a);
  const WARN = (...a) => console.warn("[MRStashSanitize]", ...a);

  LOG("Plugin loaded");

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
      { plugin_id: "MRStashSanitize", task_name: taskName, args: args || [] }
    );
  }

  async function createTag(name) {
    const data = await gqlQuery(`
      mutation TagCreate($input: TagCreateInput!) {
        tagCreate(input: $input) { id name }
      }
    `, { input: { name } });
    return data.tagCreate;
  }

  // ── Asset polling ─────────────────────────────────────────────────────────────

  async function fetchAssetJSON(filename) {
    const res = await fetch(`/plugin/MRStashSanitize/assets/${filename}?t=${Date.now()}`);
    if (!res.ok) return null;
    return res.json();
  }

  function pollUntilDone(filename, onUpdate, onDone, onError, intervalMs, maxMs) {
    const start = Date.now();
    const limit = maxMs || 300_000;
    const iv = setInterval(async () => {
      if (Date.now() - start > limit) {
        clearInterval(iv);
        onError("Timed out waiting for task.");
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
    }, intervalMs || 600);
    return () => clearInterval(iv);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function basename(p) { return p.split(/[\\/]/).pop(); }
  function dirname(p)  { const parts = p.split(/[\\/]/); parts.pop(); return parts.join("/"); }

  function studioToFolderName(studioName) {
    if (!studioName) return "";
    return studioName
      .split(/[\s_\-]+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
  }

  function applyStudioFolder(currentPath, studioFolder) {
    const grandparent = dirname(dirname(currentPath));
    const file = basename(currentPath);
    return grandparent + "/" + studioFolder + "/" + file;
  }

  function titleToStem(title) {
    return title
      .replace(/[/\\:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ── dir_class helpers ─────────────────────────────────────────────────────────

  const DIR_CLASS_LABELS = {
    ok:           null,
    wrong_studio: { label: "Wrong Studio Folder", color: "#9575cd" },
    self_titled:  { label: "Self-Titled Folder",  color: "#ff8a65" },
    shallow:      { label: "Shallow / Root Dir",  color: "#ff7043" },
  };

  function DirClassBadge({ dirClass }) {
    const info = DIR_CLASS_LABELS[dirClass];
    if (!info) return null;
    return ce("span", {
      className: "ss-dir-class-badge",
      style: { borderColor: info.color + "55", color: info.color, background: info.color + "12" },
      title: `Directory issue: ${info.label}`,
    }, info.label);
  }

  // ── Icons ─────────────────────────────────────────────────────────────────────

  const IconScan  = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:16,height:16,fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},ce("circle",{cx:11,cy:11,r:8}),ce("line",{x1:21,y1:21,x2:16.65,y2:16.65}));
  const IconCheck = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:14,height:14,fill:"none",stroke:"currentColor",strokeWidth:2.5,strokeLinecap:"round",strokeLinejoin:"round"},ce("polyline",{points:"20 6 9 17 4 12"}));
  const IconX     = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:14,height:14,fill:"none",stroke:"currentColor",strokeWidth:2.5,strokeLinecap:"round",strokeLinejoin:"round"},ce("line",{x1:18,y1:6,x2:6,y2:18}),ce("line",{x1:6,y1:6,x2:18,y2:18}));
  const IconTag   = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:12,height:12,fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},ce("path",{d:"M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"}),ce("line",{x1:7,y1:7,x2:"7.01",y2:7}));
  const IconPlay  = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:14,height:14,fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},ce("polygon",{points:"5 3 19 12 5 21 5 3"}));
  const IconEdit  = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:13,height:13,fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},ce("path",{d:"M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"}),ce("path",{d:"M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"}));
  const IconPlus  = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:11,height:11,fill:"none",stroke:"currentColor",strokeWidth:2.5,strokeLinecap:"round",strokeLinejoin:"round"},ce("line",{x1:12,y1:5,x2:12,y2:19}),ce("line",{x1:5,y1:12,x2:19,y2:12}));
  const IconSpinner = () => ce("div", { className: "ss-spinner" });

  const IconTitleFile = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:12,height:12,fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},
    ce("path",{d:"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"}),
    ce("polyline",{points:"14 2 14 8 20 8"}),
    ce("line",{x1:9,y1:15,x2:15,y2:15})
  );

  const IconFolder = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:12,height:12,fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},
    ce("path",{d:"M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"})
  );

  const IconWarning = () => ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:12,height:12,fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},
    ce("path",{d:"M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"}),
    ce("line",{x1:12,y1:9,x2:12,y2:13}),
    ce("line",{x1:12,y1:17,x2:"12.01",y2:17})
  );

  // ── Tag chip ──────────────────────────────────────────────────────────────────

  function TagChip({ name, isNew, isMissingStudio }) {
    if (isMissingStudio) {
      return ce("span", {
        className: "ss-tag-chip ss-tag-missing-studio",
        title: "This scene has no studio assigned — MissingStudio tag will be added so you can find and fix it later",
      }, ce(IconWarning), " MissingStudio");
    }
    return ce("span", {
      className: `ss-tag-chip ${isNew ? "ss-tag-new" : "ss-tag-existing"}`,
      title: isNew ? "Will be added" : "Already on scene",
    },
      ce(IconTag), " ", name
    );
  }

  // ── Junk chip ─────────────────────────────────────────────────────────────────

  function JunkChip({ raw, phrase, onPromote, promoting }) {
    return ce("span", {
      className: `ss-tag-chip ss-tag-junk ${promoting ? "ss-tag-junk-promoting" : ""}`,
      title: promoting
        ? "Creating tag…"
        : `Sigil token with no matching tag — click + to create "${phrase}" as a Stash tag`,
    },
      ce("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",width:11,height:11,fill:"none",stroke:"currentColor",strokeWidth:2.5,strokeLinecap:"round",strokeLinejoin:"round"},
        ce("polyline",{points:"3 6 5 6 21 6"}),
        ce("path",{d:"M19 6l-1 14H6L5 6"}),
        ce("path",{d:"M10 11v6M14 11v6"}),
        ce("path",{d:"M9 6V4h6v2"})
      ),
      " ", raw,
      " ",
      ce("button", {
        className: "ss-junk-promote-btn",
        title: `Create "${phrase}" tag and add to scene`,
        disabled: promoting,
        onClick: e => { e.stopPropagation(); onPromote(raw, phrase); },
      },
        promoting
          ? ce("div", { className: "ss-spinner ss-spinner-xs" })
          : ce(IconPlus)
      )
    );
  }

  // ── Inline filename editor ────────────────────────────────────────────────────

  function FilenameEditor({ item, overrideStem, onChangeStem }) {
    const origBase = basename(item.original_path);
    const ext      = origBase.includes(".") ? origBase.slice(origBase.lastIndexOf(".")) : "";
    const displayStem = overrideStem !== undefined ? overrideStem : item.new_stem;

    function handleUseTitle() {
      const stem = titleToStem(item.scene_title || "");
      if (stem) onChangeStem(stem);
    }

    return ce("div", { className: "ss-filename-change" },
      ce("div", { className: "ss-filename-row" },
        ce("span", { className: "ss-fname-label" }, "FROM"),
        ce("code", { className: "ss-fname ss-fname-old" }, origBase)
      ),
      ce("div", { className: "ss-filename-row" },
        ce("span", { className: "ss-fname-label" }, "TO"),
        ce("div", { className: "ss-fname-edit-wrap" },
          ce("input", {
            className: "ss-fname-input",
            type: "text",
            value: displayStem,
            onChange: e => onChangeStem(e.target.value),
            spellCheck: false,
          }),
          ce("code", { className: "ss-fname-ext" }, ext)
        ),
        item.scene_title && ce("button", {
          className: "ss-title-file-btn",
          title: `Use scene title as filename: "${item.scene_title}"`,
          onClick: handleUseTitle,
        },
          ce(IconTitleFile), " Use Title"
        )
      )
    );
  }

  // ── Studio folder badge ───────────────────────────────────────────────────────

  function StudioFolderBadge({ studioFolder, enabled, onToggle, currentPath, dirClass }) {
    const currentParent = basename(dirname(currentPath));
    const alreadyThere  = currentParent === studioFolder;

    if (alreadyThere) {
      return ce("div", { className: "ss-studio-badge ss-studio-badge-ok" },
        ce(IconFolder), " Already in studio folder: ", ce("code", null, studioFolder)
      );
    }

    // Pick a contextual reason label
    let reasonLabel = "Move to studio folder";
    if (dirClass === "self_titled") reasonLabel = "Self-titled folder → move to studio";
    else if (dirClass === "shallow") reasonLabel = "Shallow root dir → move to studio";

    return ce("div", { className: `ss-studio-badge ${enabled ? "ss-studio-badge-on" : "ss-studio-badge-off"}` },
      ce("button", {
        className: `ss-studio-toggle ${enabled ? "ss-studio-toggle-on" : ""}`,
        onClick: onToggle,
        title: enabled ? "Disable studio folder move" : "Enable studio folder move",
      },
        enabled ? ce(IconCheck) : ce(IconFolder)
      ),
      ce("span", null,
        ce(IconFolder), ` ${reasonLabel}: `,
        ce("code", null, studioFolder),
        ce("span", { className: "ss-studio-from" },
          ` (currently in: ${currentParent})`
        )
      )
    );
  }

  // ── No-studio dir badge (shown when dir is bad but no studio is assigned) ─────

  function NoStudioDirBadge({ dirClass, currentPath }) {
    const currentParent = basename(dirname(currentPath));
    const msgs = {
      self_titled: `This file is in a self-titled folder (${currentParent}/) — assign a studio to enable automatic relocation.`,
      shallow:     `This file is in a shallow/root directory — assign a studio to enable automatic relocation.`,
    };
    const msg = msgs[dirClass];
    if (!msg) return null;
    return ce("div", { className: "ss-no-studio-dir-badge" },
      ce(IconWarning), " ", msg
    );
  }

  // ── Single scene row ──────────────────────────────────────────────────────────

  function SceneRow({ item, selected, onToggle, onApplyOne, overrideStem, onChangeStem, studioEnabled, onToggleStudio }) {
    const [applying, setApplying]         = useState(false);
    const [applyDone, setApplyDone]       = useState(false);
    const [applyErr, setApplyErr]         = useState("");
    const [junkTokens, setJunkTokens]     = useState(item.unmatched_tokens || []);
    const [promotedTags, setPromotedTags] = useState([]);
    const [promoting, setPromoting]       = useState(null);

    const newTags      = item.tags_to_add || [];
    const existingTags = item.tags_already_on_scene || [];
    const strippedJunk = item.stripped_unmatched;
    const studioFolder = item.studio_folder || null;
    const dirClass     = item.dir_class || "ok";
    const needsDirFix  = item.needs_dir_fix;
    const needsMissingStudio = item.needs_missing_studio;

    async function handlePromote(raw, phrase) {
      setPromoting(raw);
      try {
        const tag = await createTag(phrase);
        setJunkTokens(prev => prev.filter(t => t.raw !== raw));
        setPromotedTags(prev => [...prev, { tag_id: tag.id, tag_name: tag.name }]);
        onApplyOne && onApplyOne(item.scene_id, "add_tag", { tag_id: tag.id, tag_name: tag.name });
      } catch (e) {
        WARN("Promote failed:", e);
      } finally {
        setPromoting(null);
      }
    }

    async function handleApplyThis() {
      setApplying(true);
      setApplyErr("");
      try {
        await onApplyOne(item.scene_id, "apply", { overrideStem, studioEnabled });
        setApplyDone(true);
      } catch (e) {
        setApplyErr(e.message || "Apply failed");
      } finally {
        setApplying(false);
      }
    }

    if (applyDone) {
      return ce("div", { className: "ss-row ss-row-done" },
        ce("div", { className: "ss-row-done-msg" },
          ce(IconCheck), " Applied — ", ce("code", null, basename(item.original_path))
        )
      );
    }

    // Determine row accent class
    let rowAccent = "";
    if (needsMissingStudio) rowAccent = "ss-row-missing-studio";
    else if (needsDirFix && !studioFolder) rowAccent = "ss-row-dir-warn";

    return ce("div", { className: `ss-row ${selected ? "ss-row-selected" : ""} ${rowAccent}` },
      // Checkbox
      ce("div", { className: "ss-row-check", onClick: onToggle },
        ce("div", { className: `ss-checkbox ${selected ? "ss-checkbox-on" : ""}` },
          selected ? ce(IconCheck) : null
        )
      ),

      // Body
      ce("div", { className: "ss-row-body" },
        // Title + dir-class badge
        ce("div", { className: "ss-scene-title" },
          ce("span", { className: "ss-scene-id" }, `#${item.scene_id}`),
          " ",
          item.scene_title,
          " ",
          dirClass !== "ok" && ce(DirClassBadge, { dirClass })
        ),

        item.filename_changes
          ? ce(FilenameEditor, { item, overrideStem, onChangeStem })
          : ce("div", { className: "ss-no-rename" }, "Filename unchanged — directory/tag changes only"),

        // Studio folder move row
        studioFolder
          ? ce(StudioFolderBadge, {
              studioFolder,
              enabled: studioEnabled,
              onToggle: onToggleStudio,
              currentPath: item.original_path,
              dirClass,
            })
          : needsDirFix && ce(NoStudioDirBadge, { dirClass, currentPath: item.original_path }),

        // Tags
        (newTags.length > 0 || existingTags.length > 0 || junkTokens.length > 0
          || promotedTags.length > 0 || needsMissingStudio) &&
          ce("div", { className: "ss-tags-row" },
            needsMissingStudio && ce(TagChip, { isMissingStudio: true }),
            newTags.map(t => ce(TagChip, { key: t.tag_id, name: t.tag_name, isNew: true })),
            promotedTags.map(t => ce(TagChip, { key: t.tag_id, name: t.tag_name, isNew: true })),
            existingTags.map(t => ce(TagChip, { key: t.tag_id, name: t.tag_name, isNew: false })),
            strippedJunk && junkTokens.map(t =>
              ce(JunkChip, {
                key: t.raw,
                raw: t.raw,
                phrase: t.phrase,
                onPromote: handlePromote,
                promoting: promoting === t.raw,
              })
            )
          ),

        applyErr && ce("div", { className: "ss-row-err" }, applyErr)
      ),

      // Per-row actions
      ce("div", { className: "ss-row-actions" },
        ce("button", {
          className: "ss-icon-btn ss-icon-btn-apply",
          title: "Apply this scene only",
          disabled: applying,
          onClick: handleApplyThis,
        },
          applying ? ce(IconSpinner) : ce(IconPlay)
        ),
        ce("button", {
          className: `ss-icon-btn ${selected ? "ss-icon-btn-active" : ""}`,
          onClick: onToggle,
          title: selected ? "Deselect" : "Select for bulk apply",
        }, selected ? ce(IconX) : ce(IconCheck))
      )
    );
  }

  // ── Main Modal ────────────────────────────────────────────────────────────────

  function SanitizeModal({ onClose }) {
    const [phase, setPhase]               = useState("idle");
    const [scanStatus, setScanStatus]     = useState(null);
    const [report, setReport]             = useState(null);
    const [stemOverrides, setStemOverrides] = useState({});
    const [extraTags, setExtraTags]       = useState({});
    const [selected, setSelected]         = useState(new Set());
    const [studioEnabled, setStudioEnabled] = useState({});
    const [applyMsg, setApplyMsg]         = useState("");
    const [errorMsg, setErrorMsg]         = useState("");
    const [filter, setFilter]             = useState("all");
    const [search, setSearch]             = useState("");
    const [appliedIds, setAppliedIds]     = useState(new Set());
    const cancelRef = useRef(null);

    useEffect(() => {
      document.body.style.overflow = "hidden";
      fetchAssetJSON("sanitize_report.json").then(data => {
        if (data && data.status === "done" && data.pending && data.pending.length > 0) {
          setReport(data);
          setSelected(new Set(data.pending.map(p => p.scene_id)));
          initStudioEnabled(data.pending);
          setPhase("review");
        }
      }).catch(() => {});
      return () => { document.body.style.overflow = ""; };
    }, []);

    function initStudioEnabled(pending) {
      const map = {};
      for (const p of pending) {
        if (p.studio_folder) {
          const currentParent = basename(dirname(p.original_path));
          map[p.scene_id] = currentParent !== p.studio_folder;
        }
      }
      setStudioEnabled(map);
    }

    // ── Scan ──────────────────────────────────────────────────────────────────

    async function handleScan() {
      if (cancelRef.current) cancelRef.current();
      setPhase("scanning");
      setScanStatus({ status: "running", message: "Starting scan…", progress: 0 });
      setReport(null);
      setSelected(new Set());
      setStemOverrides({});
      setExtraTags({});
      setStudioEnabled({});
      setAppliedIds(new Set());
      setErrorMsg("");
      setApplyMsg("");

      try {
        await runPluginTask("Scan for Dirty Filenames", []);
      } catch (e) {
        setPhase("error");
        setErrorMsg("Failed to start scan: " + e.message);
        return;
      }

      cancelRef.current = pollUntilDone(
        "sanitize_status.json",
        (data) => setScanStatus(data),
        async (_data) => {
          const r = await fetchAssetJSON("sanitize_report.json");
          if (r) {
            setReport(r);
            setSelected(new Set(r.pending.map(p => p.scene_id)));
            initStudioEnabled(r.pending);
          }
          setPhase("review");
        },
        (err) => { setPhase("error"); setErrorMsg(err); },
        600, 300_000
      );
    }

    // ── Per-row callback ──────────────────────────────────────────────────────

    async function handleRowAction(sceneId, mode, payload) {
      if (mode === "add_tag") {
        setExtraTags(prev => ({
          ...prev,
          [sceneId]: [...(prev[sceneId] || []), payload.tag_id],
        }));
        return;
      }

      if (mode === "apply") {
        const item = (report.pending || []).find(p => p.scene_id === sceneId);
        if (!item) return;

        const origBase = basename(item.original_path);
        const ext = origBase.includes(".") ? origBase.slice(origBase.lastIndexOf(".")) : "";
        const overrideStem = payload.overrideStem;
        const effectiveStem = (overrideStem !== undefined && overrideStem !== item.new_stem)
          ? overrideStem
          : item.new_stem;

        // Determine destination folder
        let destDir = dirname(item.original_path);
        const dirClass = item.dir_class || "ok";
        if (payload.studioEnabled && item.studio_folder && dirClass !== "ok") {
          destDir = dirname(dirname(item.original_path)) + "/" + item.studio_folder;
        }

        const newPath = destDir + "/" + effectiveStem + ext;
        const promoted = extraTags[sceneId] || [];
        const allTagIds = [...new Set([...item.all_tag_ids, ...promoted])];

        await applySingleScene(item, newPath, allTagIds);
        setAppliedIds(prev => new Set([...prev, sceneId]));
        setReport(prev => ({
          ...prev,
          pending: (prev.pending || []).filter(p => p.scene_id !== sceneId),
        }));
        setSelected(prev => { const n = new Set(prev); n.delete(sceneId); return n; });
      }
    }

    async function applySingleScene(item, newPath, allTagIds) {
      if (item.original_path !== newPath) {
        const destFolder   = dirname(newPath);
        const destBasename = basename(newPath);
        await gqlQuery(`
          mutation MoveFiles($input: MoveFilesInput!) {
            moveFiles(input: $input)
          }
        `, { input: { ids: [item.file_id], destination_folder: destFolder, destination_basename: destBasename } });
      }

      let newTitle = item.scene_title || "";
      const tokensToStrip = [...(item.matched_tokens || [])];
      if (item.stripped_unmatched) tokensToStrip.push(...(item.unmatched_tokens || []));
      for (const tok of tokensToStrip) {
        newTitle = newTitle.replace(new RegExp(escapeRegex(tok.raw), "gi"), "");
      }
      newTitle = newTitle.replace(/\s+/g, " ").trim() || basename(newPath).replace(/\.[^.]+$/, "");

      await gqlQuery(`
        mutation SceneUpdate($input: SceneUpdateInput!) {
          sceneUpdate(input: $input) { id }
        }
      `, { input: { id: item.scene_id, title: newTitle, tag_ids: allTagIds } });
    }

    function escapeRegex(str) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // ── Bulk apply ────────────────────────────────────────────────────────────

    async function handleApply() {
      if (!report || selected.size === 0) return;
      setPhase("applying");
      setApplyMsg("Applying changes…");
      setErrorMsg("");

      const toApply = (report.pending || []).filter(p => selected.has(p.scene_id));
      let done = 0, errors = 0;

      for (const item of toApply) {
        try {
          const origBase = basename(item.original_path);
          const ext = origBase.includes(".") ? origBase.slice(origBase.lastIndexOf(".")) : "";
          const overrideStem = stemOverrides[item.scene_id];
          const effectiveStem = (overrideStem !== undefined) ? overrideStem : item.new_stem;

          const dirClass = item.dir_class || "ok";
          let destDir = dirname(item.original_path);
          if (studioEnabled[item.scene_id] && item.studio_folder && dirClass !== "ok") {
            destDir = dirname(dirname(item.original_path)) + "/" + item.studio_folder;
          }

          const newPath = destDir + "/" + effectiveStem + ext;
          const promoted = extraTags[item.scene_id] || [];
          const allTagIds = [...new Set([...item.all_tag_ids, ...promoted])];
          await applySingleScene(item, newPath, allTagIds);
          done++;
        } catch (e) {
          WARN("Apply error for scene", item.scene_id, e);
          errors++;
        }
      }

      setReport(prev => ({
        ...prev,
        pending: (prev.pending || []).filter(p => !selected.has(p.scene_id)),
      }));
      setSelected(new Set());
      setApplyMsg(`Applied ${done} change${done !== 1 ? "s" : ""}${errors ? `, ${errors} errors` : ""}. Run a library scan to update Stash.`);
      setPhase("done");
    }

    // ── Selection helpers ─────────────────────────────────────────────────────

    function toggleAll(val) {
      if (!report) return;
      setSelected(val ? new Set(filtered.map(p => p.scene_id)) : new Set());
    }

    function toggleOne(id) {
      setSelected(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }

    function toggleStudio(id) {
      setStudioEnabled(prev => ({ ...prev, [id]: !prev[id] }));
    }

    // ── Derived data ──────────────────────────────────────────────────────────

    const pending  = (report && report.pending) || [];

    // A scene qualifies for "Tags Only" when it has tags PARSED FROM THE
    // FILENAME (bracket [TagA, TagB] or sigil _Tag/#Tag) to add, and no
    // filename change. MissingStudio is deliberately excluded here — it's not a
    // parsed tag and has its own "No Studio" tab.
    const hasParsedTags = p => p.tags_to_add && p.tags_to_add.length > 0;

    // Compute summary counts for filter tabs
    const filenameCount     = pending.filter(p => p.filename_changes).length;
    const tagsOnlyCount     = pending.filter(p => !p.filename_changes && hasParsedTags(p)).length;
    const studioCount       = pending.filter(p => p.studio_folder && p.dir_class !== "ok").length;
    const dirIssueCount     = pending.filter(p => p.needs_dir_fix).length;
    const missingStudioCount = pending.filter(p => p.needs_missing_studio).length;

    const filtered = pending.filter(p => {
      if (filter === "filename"  && !p.filename_changes)  return false;
      if (filter === "tagsonly"  && (p.filename_changes || !hasParsedTags(p))) return false;
      if (filter === "studio"    && (!p.studio_folder || p.dir_class === "ok")) return false;
      if (filter === "dirissue"  && !p.needs_dir_fix)     return false;
      if (filter === "nostudio"  && !p.needs_missing_studio) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(p.scene_title + p.original_path).toLowerCase().includes(q)) return false;
      }
      return true;
    });

    const allFilteredSelected = filtered.length > 0 && filtered.every(p => selected.has(p.scene_id));

    // ── Filter tab definitions ────────────────────────────────────────────────
    const filterTabs = [
      { key: "all",       label: "All" },
      { key: "filename",  label: `Rename (${filenameCount})` },
      { key: "tagsonly",  label: `Tags Only (${tagsOnlyCount})` },
      { key: "studio",    label: `Studio Move (${studioCount})` },
      { key: "dirissue",  label: `Dir Issues (${dirIssueCount})` },
      { key: "nostudio",  label: `No Studio (${missingStudioCount})` },
    ].filter(t => {
      // Hide zero-count contextual tabs to keep UI tidy
      if (t.key === "tagsonly" && tagsOnlyCount === 0)      return false;
      if (t.key === "studio"   && studioCount === 0)        return false;
      if (t.key === "dirissue" && dirIssueCount === 0)      return false;
      if (t.key === "nostudio" && missingStudioCount === 0) return false;
      return true;
    });

    // ── Render ────────────────────────────────────────────────────────────────

    return ce("div", { className: "ss-overlay", onClick: e => { if (e.target === e.currentTarget) onClose(); } },
      ce("div", { className: "ss-modal" },

        // Header
        ce("div", { className: "ss-modal-header" },
          ce("div", { className: "ss-header-left" },
            ce("h2", null, "Filename Sanitizer"),
            ce("p", { className: "ss-subtitle" },
              "Detect tag-like tokens, fix filenames, move scenes to studio folders, and tag scenes missing studio assignments."
            )
          ),
          ce("button", { className: "ss-close-btn", onClick: onClose }, ce(IconX))
        ),

        // Scan bar
        ce("div", { className: "ss-scan-bar" },
          ce("button", {
            className: "ss-btn ss-btn-primary",
            onClick: handleScan,
            disabled: phase === "scanning" || phase === "applying",
          }, ce(IconScan), " ", phase === "scanning" ? "Scanning…" : "Scan Library"),

          scanStatus && phase === "scanning" && ce("div", { className: "ss-scan-progress" },
            ce("div", { className: "ss-progress-track" },
              ce("div", { className: "ss-progress-fill", style: { width: (scanStatus.progress || 2) + "%" } })
            ),
            ce("span", { className: "ss-scan-msg" }, scanStatus.message)
          ),

          report && phase !== "scanning" && ce("div", { className: "ss-scan-summary" },
            ce("span", { className: "ss-stat" },
              ce("strong", null, pending.length), " scenes to sanitize"
            ),
            report.total_scanned && ce("span", { className: "ss-stat-muted" },
              ` of ${report.total_scanned} scanned`
            ),
            studioCount > 0 && ce("span", { className: "ss-stat-studio" },
              ce(IconFolder), ` ${studioCount} studio moves`
            ),
            dirIssueCount > 0 && ce("span", { className: "ss-stat-dirissue" },
              ce(IconWarning), ` ${dirIssueCount} dir issues`
            ),
            missingStudioCount > 0 && ce("span", { className: "ss-stat-nostudio" },
              ce(IconWarning), ` ${missingStudioCount} missing studio`
            )
          )
        ),

        errorMsg && ce("div", { className: "ss-error-bar" }, errorMsg),
        phase === "done" && applyMsg && ce("div", { className: "ss-success-bar" }, applyMsg),

        // Review table
        (phase === "review" || phase === "applying" || phase === "done") && pending.length > 0 && ce("div", { className: "ss-review-section" },

          // Toolbar
          ce("div", { className: "ss-toolbar" },
            ce("label", { className: "ss-select-all" },
              ce("div", {
                className: `ss-checkbox ${allFilteredSelected ? "ss-checkbox-on" : ""}`,
                onClick: () => toggleAll(!allFilteredSelected),
              }, allFilteredSelected ? ce(IconCheck) : null),
              ce("span", null, `${selected.size} selected`)
            ),

            ce("div", { className: "ss-filter-group" },
              filterTabs.map(f =>
                ce("button", {
                  key: f.key,
                  className: `ss-filter-btn ${filter === f.key ? "ss-filter-active" : ""}`,
                  onClick: () => setFilter(f.key),
                }, f.label)
              )
            ),

            ce("input", {
              className: "ss-search",
              type: "text",
              placeholder: "Search…",
              value: search,
              onChange: e => setSearch(e.target.value),
            })
          ),

          // List
          ce("div", { className: "ss-list" },
            filtered.length === 0
              ? ce("div", { className: "ss-empty-list" }, "No scenes match the current filter.")
              : filtered.map(item =>
                  ce(SceneRow, {
                    key: item.scene_id,
                    item,
                    selected: selected.has(item.scene_id),
                    onToggle: () => toggleOne(item.scene_id),
                    onApplyOne: handleRowAction,
                    overrideStem: stemOverrides[item.scene_id],
                    onChangeStem: val => setStemOverrides(prev => ({ ...prev, [item.scene_id]: val })),
                    studioEnabled: studioEnabled[item.scene_id] || false,
                    onToggleStudio: () => toggleStudio(item.scene_id),
                  })
                )
          )
        ),

        pending.length === 0 && (phase === "review" || phase === "done") && ce("div", { className: "ss-empty-state" },
          "✓ No scenes need sanitization."
        ),

        // Action bar
        (phase === "review" || phase === "applying" || phase === "done") && pending.length > 0 &&
          ce("div", { className: "ss-action-bar" },
            phase === "applying"
              ? ce("div", { className: "ss-applying-msg" },
                  ce(IconSpinner),
                  applyMsg || "Applying changes…"
                )
              : ce("button", {
                  className: "ss-btn ss-btn-primary",
                  onClick: handleApply,
                  disabled: selected.size === 0 || phase !== "review",
                }, `Apply ${selected.size} Selected`),

            ce("button", {
              className: "ss-btn ss-btn-secondary",
              onClick: () => toggleAll(false),
              disabled: selected.size === 0,
            }, "Deselect All"),

            ce("button", {
              className: "ss-btn ss-btn-secondary",
              onClick: () => toggleAll(true),
              disabled: filtered.every(p => selected.has(p.scene_id)),
            }, "Select All")
          )
      )
    );
  }

  // ── Mount / unmount ───────────────────────────────────────────────────────────

  let _modalRoot = null;

  function openModal() {
    if (!_modalRoot) {
      _modalRoot = document.createElement("div");
      _modalRoot.id = "ss-modal-root";
      document.body.appendChild(_modalRoot);
    }
    ReactDOM.render(ce(SanitizeModal, { onClose: closeModal }), _modalRoot);
  }

  function closeModal() {
    if (_modalRoot) ReactDOM.unmountComponentAtNode(_modalRoot);
  }

  // ── Nav button injection ──────────────────────────────────────────────────────

  function injectNavButton() {
    if (document.getElementById("ss-nav-btn")) return;
    const navbar = document.querySelector(".navbar") || document.querySelector("nav");
    if (!navbar) return;
    const target =
      navbar.querySelector(".navbar-buttons") ||
      navbar.querySelector(".ml-auto.navbar-nav") ||
      navbar.querySelector(".navbar-nav:last-child") ||
      navbar;

    const btn = document.createElement("button");
    btn.id = "ss-nav-btn";
    btn.title = "Filename Sanitizer";
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
    </svg>`;
    btn.style.cssText = [
      "background:transparent","border:none","color:#aaa","cursor:pointer",
      "padding:6px","display:inline-flex","align-items:center",
      "justify-content:center","border-radius:4px","line-height:1",
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