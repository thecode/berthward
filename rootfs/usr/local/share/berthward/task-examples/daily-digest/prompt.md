Write a short morning status of this Unraid server for its owner. At most 8 lines.

Check, with read-only commands only:

- Storage: `host zpool status`, `host zpool list`, `host df -h` (flag a pool, share or disk above 80% full), `host mdcmd status` for the array.
- Containers: `docker ps -a` (flag ones that are unhealthy, restarting, or exited with a non-zero status).
- VMs: `host virsh list --all`.
- Load and memory: `host uptime`, `host free -h`.

Lead with anything that needs attention. If nothing does, say so in one line and
add two or three key numbers (free space, containers running, uptime).

This is a digest, so always answer with the status: do not reply "OK".
