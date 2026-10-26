# MRStashDupManager

A Stash plugin that detects duplicate scenes using Stash's built-in perceptual-hash
(phash) matching and presents a modern, side-by-side review UI for keeping the best
copy and deleting or removing the rest. It does what DupFileManager does under the
hood, but with a clean React-based modal in the style of MRStashSanitize.

## Requirements

- Run Stash's **Generate Phashes** scan task first (Settings → Tasks → Generate,
  with "Perceptual hashes (phash)" enabled). Duplicate detection relies on phashes.

## Installation

1. Create a folder named `MRStashDupManager` in your Stash plugins directory
   (e.g. `~/.stash/plugins/MRStashDupManager`).
2. Copy all plugin files into it.
3. Click **Reload Plugins** in Settings → Plugins.

## Usage

- Click the duplicate-files icon added to the Stash top navigation bar to open the UI.
- Press **Scan for Duplicates**. When it finishes, each duplicate group is shown with
  the auto-chosen copy to KEEP on the left and the candidate(s) for deletion on the right.
- For each candidate you can:
  - **Delete file** — remove the scene from Stash and delete the file from disk.
  - **Remove from Stash** — remove the scene from the library but keep the file.
  - **Merge → delete** — copy tags & performers onto the kept scene, then delete the file.
  - **Exclude** — tag the scene `_DuplicateExclude` and skip it.
- Use **Keep this** on any card to override which copy is kept.

## How the "keep" copy is chosen

In priority order: whitelist path > higher resolution > longer duration > higher
bitrate > larger file size > longer (deeper) path. Whitelist/gray-list/black-list
paths are configured in the plugin settings.

## Settings

- **Match Distance** — phash hamming distance (0 = exact, safest).
- **Max Duration Difference** — only match scenes within N seconds of each other
  (-1 disables).
- **Whitelist / Gray-list / Blacklist Paths** — comma-separated path preferences that
  decide which copy is kept and which are deletion candidates.

## Tasks

- **Scan for Duplicates** — builds the report the UI reads (also runnable from Tasks).
- **Tag Duplicates** — applies `_DuplicateMarkForDeletion` to the lower-quality copy in
  each group, for review via Stash's normal library filters.
