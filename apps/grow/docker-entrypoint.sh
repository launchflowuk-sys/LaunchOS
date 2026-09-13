#!/bin/sh
# Writes `tracking.js` from its template, then hands over to nginx.
#
# A static page cannot read an environment variable, so the ids are baked in at
# container start instead of at build time. That keeps them out of git and out
# of the image, and means changing a pixel id in Coolify is a restart rather
# than a rebuild.
#
# `envsubst` is given an explicit variable list. Without it, it would replace
# every `$`-prefixed token in the file — including JavaScript that has nothing
# to do with configuration.
set -eu

export GROW_GA4_ID="${GROW_GA4_ID:-}"
export GROW_META_PIXEL_ID="${GROW_META_PIXEL_ID:-}"
export GROW_ADS_CONVERSION_ID="${GROW_ADS_CONVERSION_ID:-}"

envsubst '${GROW_GA4_ID} ${GROW_META_PIXEL_ID} ${GROW_ADS_CONVERSION_ID}' \
  < /etc/launchflow/tracking.js.template \
  > /usr/share/nginx/html/tracking.js

if [ -z "$GROW_GA4_ID" ] && [ -z "$GROW_META_PIXEL_ID" ]; then
  echo "[grow] no GROW_GA4_ID or GROW_META_PIXEL_ID set — tracking.js is inert, no tags will load"
else
  echo "[grow] tracking configured: ga4=${GROW_GA4_ID:-none} pixel=${GROW_META_PIXEL_ID:-none} ads=${GROW_ADS_CONVERSION_ID:-none}"
fi

exec "$@"
