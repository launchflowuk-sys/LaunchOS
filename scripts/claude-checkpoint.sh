#!/usr/bin/env bash
#
# Work-in-progress insurance for LaunchOS.
#
# `save` snapshots the whole working tree — tracked edits and new untracked
# files alike — into a commit under refs/checkpoints/. It builds that commit
# through a throwaway index, so HEAD, the real index and the files on disk are
# never touched. Nothing you are part-way through is ever staged, stashed or
# reverted by this script.
#
# `context` prints what the last session left behind, so the next one starts
# knowing where the work stopped instead of guessing.
#
# Wired to Stop / SessionEnd / SessionStart hooks in .claude/settings.json.
# It must never fail a session, so every path ends in exit 0.

set -uo pipefail

KEEP=40   # checkpoints retained per branch

repo_root() { git rev-parse --show-toplevel 2>/dev/null; }

state_file() { printf '%s/.claude/session-state.md' "$1"; }

# Build a tree object from the working directory without disturbing the real
# index. GIT_INDEX_FILE must name a path that does not exist yet — git treats a
# zero-byte file as a corrupt index.
worktree_tree() {
  local tmp_index
  tmp_index="$(mktemp -u)" || return 1
  GIT_INDEX_FILE="$tmp_index" git add -A >/dev/null 2>&1 || { rm -f "$tmp_index"; return 1; }
  GIT_INDEX_FILE="$tmp_index" git write-tree 2>/dev/null
  local rc=$?
  rm -f "$tmp_index"
  return $rc
}

cmd_save() {
  local root branch slug tree head last last_tree ref stamp commit dirty count
  root="$(repo_root)" || exit 0
  cd "$root" || exit 0

  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0
  [ -n "$branch" ] || exit 0
  slug="${branch//\//-}"

  tree="$(worktree_tree)" || exit 0
  [ -n "$tree" ] || exit 0

  # Skip when this exact tree is already checkpointed — Stop fires on every
  # turn, and identical snapshots are noise.
  last="$(git for-each-ref --sort=-refname --count=1 --format='%(objectname)' "refs/checkpoints/$slug/" 2>/dev/null)"
  if [ -n "$last" ]; then
    last_tree="$(git rev-parse "$last^{tree}" 2>/dev/null)"
    [ "$tree" = "$last_tree" ] && { cmd_context_write "$root" "$branch"; exit 0; }
  fi

  head="$(git rev-parse HEAD 2>/dev/null)"
  dirty="$(git status --porcelain=v1 2>/dev/null)"
  count="$(printf '%s' "$dirty" | grep -c . )"
  stamp="$(date +%Y%m%d-%H%M%S)"

  commit="$(printf 'checkpoint(%s): %s uncommitted path(s) at %s\n\n%s\n' \
    "$branch" "$count" "$stamp" "$dirty" \
    | git commit-tree "$tree" -p "$head" -F - 2>/dev/null)" || exit 0
  [ -n "$commit" ] || exit 0

  git update-ref "refs/checkpoints/$slug/$stamp" "$commit" 2>/dev/null

  # Keep the namespace from growing without bound.
  git for-each-ref --sort=-refname --format='%(refname)' "refs/checkpoints/$slug/" 2>/dev/null \
    | tail -n "+$((KEEP + 1))" \
    | while IFS= read -r old; do git update-ref -d "$old" 2>/dev/null; done

  cmd_context_write "$root" "$branch"
  exit 0
}

# Record where the work stands, for the next session to read on start.
cmd_context_write() {
  local root="$1" branch="$2" sf
  sf="$(state_file "$root")"
  mkdir -p "$(dirname "$sf")" 2>/dev/null || return 0
  {
    printf '# Last session state — %s\n\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
    printf '- Branch: `%s`\n' "$branch"
    printf '- HEAD: `%s` %s\n' \
      "$(git rev-parse --short HEAD 2>/dev/null)" \
      "$(git log -1 --pretty=%s 2>/dev/null)"
    printf '- Upstream: %s\n' \
      "$(git status -sb 2>/dev/null | head -1 | sed 's/^## //')"
    printf '- Latest checkpoint: `%s`\n\n' \
      "$(git for-each-ref --sort=-refname --count=1 --format='%(refname:short) -> %(objectname:short)' "refs/checkpoints/${branch//\//-}/" 2>/dev/null)"
    printf '## Uncommitted when the session ended\n\n'
    if [ -n "$(git status --porcelain=v1 2>/dev/null)" ]; then
      printf '```\n%s\n```\n\n' "$(git status --porcelain=v1 2>/dev/null)"
      printf 'Recover any of it with:\n```\ngit restore --source=<checkpoint-sha> -- <path>\n```\n'
    else
      printf 'Nothing — the tree was clean.\n'
    fi
  } > "$sf" 2>/dev/null
  return 0
}

# Emit the state file to Claude as SessionStart context.
cmd_context() {
  local root sf
  root="$(repo_root)" || exit 0
  sf="$(state_file "$root")"
  [ -f "$sf" ] || exit 0
  node -e '
    let s = "";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "Where the previous session in this repo left off (from scripts/claude-checkpoint.sh):\n\n" + s
        }
      }));
    });
  ' < "$sf" 2>/dev/null
  exit 0
}

case "${1:-save}" in
  save)    cmd_save ;;
  context) cmd_context ;;
  *)       exit 0 ;;
esac
