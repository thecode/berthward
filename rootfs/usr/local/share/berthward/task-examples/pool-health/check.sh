#!/bin/bash
# pool-health — ZFS pools and the Unraid array.
#
# Quiet when all is well. Otherwise prints what is wrong and exits 1, which
# the bridge posts as an alert (once, then again when the output changes or
# after the reminder interval).
#
# `/run pool-health --report` shows what the check saw: every ZFS pool with
# its health and how full it is, the array's state and every array slot that
# holds a disk. It changes nothing and exits like a normal run.
#
# The lines are written for `"highlight": "diff"` in task.json: Discord shows
# a line that starts with "+" in green and one that starts with "-" in red.
# 🔴 marks a fault and 🟡 a warning; faults come first.

# ── Arguments ────────────────────────────────────────────────────────────────
# Only `/run pool-health <words>` passes any; a scheduled run has none.
report=false
for arg in "$@"; do
  case "$arg" in
    --report) report=true ;;
    *) echo "pool-health: unknown argument $arg. The only one is --report."; exit 2 ;;
  esac
done

problems=()   # what needs attention: what a normal run prints
shown=()      # everything looked at: what --report prints

# ── ZFS ──────────────────────────────────────────────────────────────────────
if zfs_out=$(host zpool status -x 2>&1); then
  case "$zfs_out" in
    "all pools are healthy" | "no pools available") ;;
    *) problems+=("- 🔴 ZFS:"$'\n'"$zfs_out") ;;
  esac
elif ! grep -qiE 'not found|no such file' <<<"$zfs_out"; then
  problems+=("- 🟡 ZFS: zpool status failed:"$'\n'"$zfs_out")
fi
if $report; then
  if pools=$(host zpool list -H -o name,health,size,alloc,free 2>/dev/null) && [ -n "$pools" ]; then
    while IFS=$'\t' read -r name health size alloc free; do
      [ "$health" = ONLINE ] && mark="+" || mark="- 🔴"
      shown+=("$mark ZFS pool $name: $health, $alloc of $size used, $free free")
    done <<<"$pools"
  else
    shown+=("  ZFS: no pools")
  fi
fi

# ── Unraid array ─────────────────────────────────────────────────────────────
# Slot 0 is parity and slot 29 the second parity. DISK_NP_DSBL there means no
# parity disk is assigned, which is a setup choice, not a fault; on a data slot
# it means a missing disk.
# The awk part prints "P" lines for problems and "R" lines for --report, each
# with a number to sort by: faults before warnings, then by slot.
if md=$(host mdcmd status 2>/dev/null) && [ -n "$md" ]; then
  while IFS=$'\t' read -r kind _ line; do
    case "$kind" in
      P) problems+=("$line") ;;
      R) shown+=("$line") ;;
    esac
  done < <(awk -F= '
    /^mdState=/        { state = $2 }
    /^rdevStatus\./    { split($1, a, "."); st[a[2]] = $2 }
    /^rdevName\./      { split($1, a, "."); nm[a[2]] = $2 }
    /^rdevNumErrors\./ { split($1, a, "."); er[a[2]] = $2 }
    /^sbSyncErrs=/     { sync = $2 }
    END {
      mark = (state == "STARTED" ? "+" : " ")
      if (sync + 0 > 0) {
        mark = "- 🟡"
        printf "P\t100\t- 🟡 Array: the last parity check found %d sync errors\n", sync
      }
      printf "R\t-1\t%s Array: %s, %d sync errors at the last parity check\n", mark, state, sync
      for (i in st) {
        parity = (i == 0 || i == 29)
        slot = (parity ? "parity" (i == 29 ? "2" : "") : "disk" i)
        at = (i == 29 ? 0.5 : i)
        name = (nm[i] == "" ? "no device" : nm[i])
        ok = (st[i] == "DISK_OK" || st[i] == "DISK_NP" || (parity && st[i] == "DISK_NP_DSBL"))
        mark = "+"
        if (!ok) {
          mark = "- 🔴"
          printf "P\t%s\t- 🔴 Array %s (%s): %s\n", at, slot, name, st[i]
        } else if (er[i] + 0 > 0) {
          mark = "- 🟡"
          printf "P\t%s\t- 🟡 Array %s (%s): %d read/write errors\n", 50 + at, slot, name, er[i]
        }
        # An empty slot is only worth a line when it should not be empty.
        if (nm[i] != "") printf "R\t%s\t%s Array %s (%s): %s, %d read/write errors\n", at, mark, slot, name, st[i], er[i]
        else if (!ok)    printf "R\t%s\t%s Array %s (no device): %s\n", at, mark, slot, st[i]
      }
    }' <<<"$md" | sort -t$'\t' -k1,1 -k2,2n)
elif $report; then
  shown+=("  Array: no answer from mdcmd status")
fi

if $report; then
  printf '%s\n' "${shown[@]}"
  [ ${#problems[@]} -eq 0 ] && exit 0
  printf '\nNeeds attention:\n'
  printf '%s\n' "${problems[@]}"
  exit 1
fi

[ ${#problems[@]} -eq 0 ] && exit 0
printf '%s\n' "${problems[@]}"
exit 1
