#!/bin/bash
# replaces plugins/<name> with the committed contents of each repo in plugins.txt
# usage: ./sync_plugins.sh [--local <dir>]
#   --local <dir>  read from existing checkouts at <dir>/<name> instead of cloning
# files marked export-ignore in a plugin's .gitattributes are left out
# prints <name>@<commit> for each synced plugin

set -euo pipefail
cd "$(dirname "$0")"

localdir=""
if [ "${1:-}" = "--local" ]; then
    localdir=$(realpath "${2:?--local requires a directory}")
fi

# never shipped in plugin zips
excludes=(.idea .github .gitignore .gitattributes)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

while read -r name url ref <&3; do
    [[ -z "$name" || "$name" == \#* ]] && continue

    if [ -n "$localdir" ]; then
        src="$localdir/$name"
        treeish="${ref:-HEAD}"
    else
        src="$tmp/$name"
        git clone -q --depth 1 ${ref:+--branch "$ref"} "$url" "$src"
        treeish=HEAD
    fi

    dest="plugins/$name"
    rm -rf "$dest"
    mkdir -p "$dest"
    git -C "$src" archive "$treeish" | tar -x -C "$dest"
    for e in "${excludes[@]}"; do
        rm -rf "${dest:?}/$e"
    done

    echo "$name@$(git -C "$src" rev-parse --short "$treeish")"
done 3< plugins.txt
