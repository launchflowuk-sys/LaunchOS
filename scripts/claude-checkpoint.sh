#!/usr/bin/env bash
#
# Work-in-progress insurance for LaunchOS.
#
# `save` snapshots the whole working tree — tracked edits and new untracked
# files alike — into a commit under refs/checkpoints/. It builds that commit
# through a throwaway index, so HEAD, the real index and the files on disk are
# never touched. Nothing you are part-way through is staged, stashed or
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

slug_of() { printf '%s' "${1//\//-}"; }

# Build a tree object from the working directory without disturbing the real
# index. GIT_INDEX_FILE must name a path that does not exist yet — git rejects
# a zero-byte file as a corrupt index, so mktemp -u (name only) is required.
worktree_tree() {
  local tmp_index rc
  tmp_index="$(mktemp -u)" || return 1
  GIT_INDEX_FILE="$tmp_index" git add -A >/dev/null 2>&1 || { rm -f "$tmp_index"; return 1; }
  GIT_INDEX_FILE="$tmp_index" git write-tree 2>/dev/null
  rc=$?
  rm -f "$tmp_index"
  return $rc
}

# Record where the work stands, for the next session to read on start.
write_state() {
  local root="$1" branch="$2" slug sf dirty
  slug="$(slug_of "$branch")"
  sf="$(state_file "$root")"
  mkdir -p "$(dirname "$sf")" 2>/dev/null || return 0
  dirty="$(git status --porcelain=v1 2>/dev/null)"
  {
    printf '# Last session state — %s\n\n' "$(date '+%Y-%m-%d %H:%M:%S')"
    printf -- '- Branch: `%s`\n' "$branch"
    printf -- '- HEAD: `%s` %s\n' \
      "$(git rev-parse --short HEAD 2>/dev/null)" \
      "$(git log -1 --pretty=%s 2>/dev/null)"
    printf -- '- Tracking: %s\n' \
      "$(git status -sb 2>/dev/null | head -1 | sed 's/^## //')"
    printf -- '- Latest checkpoint: `%s`\n\n' \
      "$(git rev-parse --short "refs/checkpoints-last/$slug" 2>/dev/null)"
    printf '## Uncommitted when the session ended\n\n'
    if [ -n "$dirty" ]; then
      printf '```\n%s\n```\n\n' "$dirty"
      printf 'Every one of those paths is inside the checkpoint above.
'
      printf 'Inspect it:  git show <checkpoint-sha> --stat
'
      printf 'Recover one file:
'
      printf '```
git checkout <checkpoint-sha> -- <path>
git restore --staged <path>
```
'
    else
      printf 'Nothing — the tree was clean.\n'
    fi
  } > "$sf" 2>/dev/null
  return 0
}

cmd_save() {
  local root branch slug tree head last last_tree stamp commit dirty count
  root="$(repo_root)" || exit 0
  cd "$root" || exit 0

  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  [ -n "$branch" ] || exit 0
  slug="$(slug_of "$branch")"

  tree="$(worktree_tree)" || exit 0
  [ -n "$tree" ] || exit 0

  # Skip when this exact tree is already checkpointed — Stop fires on every
  # turn, and identical snapshots are noise. The newest checkpoint is tracked
  # by an explicit pointer rather than by sorting ref names, so an oddly-named
  # ref can never be mistaken for the most recent one.
  last="$(git rev-parse --verify --quiet "refs/checkpoints-last/$slug" 2>/dev/null)"
  if [ -n "$last" ]; then
    last_tree="$(git rev-parse --verify --quiet "$last^{tree}" 2>/dev/null)"
    if [ "$tree" = "$last_tree" ]; then
      write_state "$root" "$branch"
      exit 0
    fi
  fi

  head="$(git rev-parse HEAD 2>/dev/null)"
  [ -n "$head" ] || exit 0
  dirty="$(git status --porcelain=v1 2>/dev/null)"
  count="$(printf '%s' "$dirty" | grep -c .)"
  stamp="$(date +%Y%m%d-%H%M%S)"

  commit="$(printf 'checkpoint(%s): %s uncommitted path(s) at %s\n\n%s\n' \
    "$branch" "$count" "$stamp" "$dirty" \
    | git commit-tree "$tree" -p "$head" -F - 2>/dev/null)"
  [ -n "$commit" ] || exit 0

  git update-ref "refs/checkpoints/$slug/$stamp" "$commit" 2>/dev/null
  git update-ref "refs/checkpoints-last/$slug" "$commit" 2>/dev/null

  # Keep the namespace from growing without bound. Ordered by commit time, so
  # the newest survive however a ref happens to be named.
  git for-each-ref --sort=-committerdate --format='%(refname)' "refs/checkpoints/$slug/" 2>/dev/null \
    | tail -n "+$((KEEP + 1))" \
    | while IFS= read -r old; do git update-ref -d "$old" 2>/dev/null; done

  write_state "$root" "$branch"
  exit 0
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
            "Where the previous session in this repo left off " +
            "(scripts/claude-checkpoint.sh). Verify against git before acting on it:\n\n" + s
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
