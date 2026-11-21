#!/bin/bash
# pool-health — ZFS pools and the Unraid array.
#
# Quiet when all is well. Otherwise prints what is wrong and exits 1, which
# the bridge posts as an alert (once, then again when the output changes or
# after the reminder interval).
problems=()

# ── ZFS ──────────────────────────────────────────────────────────────────────
if zfs_out=$(host zpool status -x 2>&1); then
  case "$zfs_out" in
    "all pools are healthy" | "no pools available") ;;
    *) problems+=("ZFS:"$'\n'"$zfs_out") ;;
  esac
elif ! grep -qiE 'not found|no such file' <<<"$zfs_out"; then
  problems+=("ZFS: zpool status failed:"$'\n'"$zfs_out")
fi

# ── Unraid array ─────────────────────────────────────────────────────────────
# Slot 0 is parity. DISK_NP_DSBL there means no parity disk is assigned, which
# is a setup choice, not a fault; on a data slot it means a missing disk.
if md=$(host mdcmd status 2>/dev/null) && [ -n "$md" ]; then
  array=$(awk -F= '
    /^rdevStatus\./    { split($1, a, "."); st[a[2]] = $2 }
    /^rdevName\./      { split($1, a, "."); nm[a[2]] = $2 }
    /^rdevNumErrors\./ { split($1, a, "."); er[a[2]] = $2 }
    /^sbSyncErrs=/     { sync = $2 }
    END {
      for (i in st) {
        name = (nm[i] == "" ? "no device" : nm[i])
        slot = (i == 0 || i == 29 ? "parity" : "disk" i)
        ok = (st[i] == "DISK_OK" || st[i] == "DISK_NP" || ((i == 0 || i == 29) && st[i] == "DISK_NP_DSBL"))
        if (!ok)               printf "Array %s (%s): %s\n", slot, name, st[i]
        else if (er[i] + 0 > 0) printf "Array %s (%s): %d read/write errors\n", slot, name, er[i]
      }
      if (sync + 0 > 0) printf "Array: the last parity check found %d sync errors\n", sync
    }' <<<"$md" | sort)
  [ -z "$array" ] || problems+=("$array")
fi

[ ${#problems[@]} -eq 0 ] && exit 0
printf '%s\n' "${problems[@]}"
exit 1
