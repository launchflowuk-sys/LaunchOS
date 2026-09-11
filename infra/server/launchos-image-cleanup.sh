#!/bin/sh
# LaunchOS-only image cleanup, run after every deploy.
#
# Installed on the Hetzner box as /usr/local/bin/launchos-image-cleanup and run
# by root's crontab every five minutes:
#
#   */5 * * * * /usr/local/bin/launchos-image-cleanup >> /var/log/launchos-image-cleanup.log 2>&1
#
# Every push builds two images of about 2.7GB each, and nothing removed the old
# ones until the weekly global reclaim on Sunday. Five pushes in a week is the
# disk full again, and a full disk takes every site on the box down with it.
#
# What it may touch, and nothing else:
#   - images whose repository is EXACTLY one of the two LaunchOS app uuids below.
#     Coolify names every app's images after the app, so no other deployment's
#     image can match.
#
# What it never does:
#   - no `docker image prune`, no `docker system prune`, no `builder prune`:
#     those are server-wide. The build cache is shared by every app on the box
#     and carries nothing that says which app it belongs to, so it is left to
#     the weekly reclaim rather than guessed at.
#   - never removes an image any container uses, running or stopped.
#   - never `rmi -f`: if Docker thinks something still needs an image, Docker
#     wins and the image stays.
#   - never touches dangling (<none>) images: nothing proves they are ours.
#
# Keeps the newest KEEP images per app (default 2): the one running and the one
# before it, so a Coolify rollback still has something to roll back to. During a
# deploy the brand-new image is the newest, so it is always kept.
#
#   DRY_RUN=1 launchos-image-cleanup        # say what would go, remove nothing
set -eu

REPOS="tm9ihp9bjjjeew5g8nzuqqsg n7sb6hq1fnuvfufmvstwrotf"   # LaunchOS web, LaunchOS worker
KEEP="${KEEP:-2}"
DRY_RUN="${DRY_RUN:-0}"

case "$KEEP" in ''|*[!0-9]*) echo "KEEP must be a whole number" >&2; exit 2 ;; esac
[ "$KEEP" -ge 1 ] || { echo "KEEP must be at least 1" >&2; exit 2; }

# One run at a time: a slow rmi must not overlap the next cron tick.
exec 9>/run/launchos-image-cleanup.lock
flock -n 9 || exit 0

stamp() { date -u +%FT%TZ; }

for repo in $REPOS; do
  # Newest first. CreatedAt sorts correctly as text ("2026-09-11 03:59:00 +0000 UTC").
  docker images --no-trunc --format '{{.CreatedAt}}|{{.Repository}}|{{.Tag}}|{{.ID}}|{{.Size}}' \
    | awk -F'|' -v r="$repo" '$2 == r && $3 != "<none>"' \
    | sort -r \
    | tail -n +"$((KEEP + 1))" \
    | while IFS='|' read -r created name tag id size; do
        [ "$name" = "$repo" ] || continue   # belt and braces over the awk match
        ref="$name:$tag"
        in_use=$(docker ps -a -q --filter "ancestor=$id" | head -n 1)
        if [ -n "$in_use" ]; then
          echo "$(stamp) keep   $ref ($size) - a container still uses it"
          continue
        fi
        if [ "$DRY_RUN" = "1" ]; then
          echo "$(stamp) would remove $ref ($size, built $created)"
          continue
        fi
        if docker rmi "$ref" >/dev/null 2>&1; then
          echo "$(stamp) removed $ref ($size, built $created)"
        else
          echo "$(stamp) left   $ref ($size) - docker refused to remove it"
        fi
      done
done
