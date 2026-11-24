#!/bin/bash
# Prints the Unraid template with its change log brought up to date.
#
#   template-changes.sh <template.xml> <releases.json> [<entries to keep>]
#
# Community Applications shows the template's <Changes> section as the app's
# change log. The section in the repository is only the hand-written start of
# it; this adds, above what is there, one entry for every published release
# that has none yet, taken from the release's notes. releases.json is the
# answer of GitHub's "list releases" call.
#
# Only what a user of the app notices is taken over: breaking changes, new
# features, bug fixes and enhancements. Maintenance, documentation and
# dependency updates stay out. The pull request number and the author are
# dropped from each line.
#
# The change log is then cut to its newest entries (five unless told
# otherwise), hand-written ones included; the full history is on the releases
# page.
set -euo pipefail

TEMPLATE=${1:?usage: template-changes.sh <template.xml> <releases.json> [<entries to keep>]}
RELEASES=${2:?usage: template-changes.sh <template.xml> <releases.json> [<entries to keep>]}
KEEP=${3:-5}
case "$KEEP" in '' | *[!0-9]* | 0) echo "template-changes: entries to keep must be a number above 0" >&2; exit 1 ;; esac

if [ "$(grep -cE '^[[:space:]]*<Changes>[[:space:]]*$' "$TEMPLATE")" != 1 ]; then
  echo "template-changes: expected one line holding only <Changes> in $TEMPLATE" >&2
  exit 1
fi

# Versions that already have an entry.
have=$(sed -n '/<Changes>/,/<\/Changes>/p' "$TEMPLATE" | sed -n 's/^### *//p' | jq -R . | jq -s .)

new=$(mktemp)
trap 'rm -f "$new"' EXIT
jq -r --argjson have "$have" '
  def shown: test("Breaking changes|New features|Bug fixes|Enhancements");
  def xml: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
  map(select((.draft | not) and .published_at != null))
  | sort_by(.published_at) | reverse | .[]
  | (.tag_name | ltrimstr("v")) as $version
  | select($have | index($version) | not)
  | ((.body // "") | gsub("\r"; "") | split("\n")
      | reduce .[] as $line ({on: false, out: []};
          if $line | startswith("## ") then .on = ($line | shown)
          elif .on and ($line | startswith("- ")) then
            .out += [$line | sub("^- (#[0-9]+ - )?"; "- ") | sub(" \\(@.*\\)\\s*$"; "") | xml]
          else . end)
      | .out) as $lines
  | "### \($version)",
    (if ($lines | length) > 0 then $lines[] else "- Maintenance only, nothing changes in use." end),
    ""
' "$RELEASES" > "$new"

awk -v new="$new" '
  { print }
  /^[[:space:]]*<Changes>[[:space:]]*$/ { while ((getline line < new) > 0) print line }
' "$TEMPLATE" | awk -v keep="$KEEP" '
  # Inside <Changes>: stop printing after the last entry to keep. Blank lines
  # are held back until a kept line follows, so none is left before the end.
  /<\/Changes>/ { inside = 0; blanks = 0; print; next }
  !inside { print; if ($0 ~ /^[[:space:]]*<Changes>[[:space:]]*$/) { inside = 1; entries = 0 }; next }
  /^### / { entries++ }
  entries > keep { next }
  /^[[:space:]]*$/ { blanks++; next }
  { for (; blanks > 0; blanks--) print ""; print }
'
