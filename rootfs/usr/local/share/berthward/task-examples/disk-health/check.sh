#!/bin/bash
# disk-health — SMART health of the server's disks.
#
# Quiet when all is well. Otherwise prints one line per disk that needs
# attention and exits 1, which the bridge posts as an alert (once, then again
# when the output changes or after the reminder interval).
#
# A disk that is spun down is left asleep and skipped, so a sleeping disk is
# only looked at when a check happens to find it awake. USB sticks, the flash
# drive among them, have no SMART data and are not looked at.
#
# The limits are at the top of the Python part. A value that is known and
# stable (say, 8 reallocated sectors that have not grown in a year) can be
# accepted by raising its limit; the changed script then asks for approval
# again. The wording of a problem only changes when the problem does, so the
# same alert is not posted over and over.
#
# `/run disk-health --report` shows what the check saw: one line for every
# disk with the values it judges, the sleeping disks listed as skipped, and
# the limits. It reads nothing more than a normal run and wakes no disk.
exec python3 - "$@" <<'PY'
import json
import re
import subprocess
import sys

# ── Limits ───────────────────────────────────────────────────────────────────
# SATA counters that should stay at zero. id: (what it counts, highest value
# that is still fine).
ATA_COUNTERS = {
    5: ("reallocated sectors", 0),
    187: ("reported uncorrectable errors", 0),
    197: ("sectors waiting to be reallocated", 0),
    198: ("uncorrectable sectors", 0),
}
# SATA SSD attributes whose normalised value is the life left, 100 down to 0.
SSD_LIFE_ATTRS = (169, 177, 202, 231, 233)
SSD_LIFE_MIN = 10         # percent of life left
NVME_USED_MAX = 90        # percent of the rated life used
NVME_MEDIA_ERRORS_MAX = 0
TEMP_MAX_HDD = 55         # °C
TEMP_MAX_SSD = 70

# ── Collect ──────────────────────────────────────────────────────────────────
# One host call for all disks. --scan-open lists the disks smartctl can talk
# to, each with the device type to use; -n standby leaves a sleeping disk
# asleep. The answers come back as one JSON document after the other.
COLLECT = r'''
smartctl --scan-open | while read -r dev _ type _; do
  case "$dev" in /dev/*) smartctl -n standby -j -i -H -A -d "$type" "$dev"; echo ;; esac
done
'''


def host(*command):
    return subprocess.run(["host", *command], capture_output=True, text=True)


def documents(text):
    decoder = json.JSONDecoder()
    at = 0
    while True:
        at = re.compile(r"\s*").match(text, at).end()
        if at >= len(text):
            return
        try:
            doc, at = decoder.raw_decode(text, at)
        except ValueError:
            return
        yield doc


def slots():
    """Unraid's name for each disk (disk1, parity, cache …), by device."""
    names = {}
    ini = host("cat", "/var/local/emhttp/disks.ini")
    if ini.returncode == 0:
        for section in re.split(r"^\[", ini.stdout, flags=re.M):
            name = re.search(r'^name="([^"]+)"', section, flags=re.M)
            device = re.search(r'^device="([^"]+)"', section, flags=re.M)
            if name and device:
                names[device.group(1)] = name.group(1)
    return names


def label(doc, names):
    device = doc.get("device", {}).get("name", "?")
    base = device.rsplit("/", 1)[-1]
    slot = names.get(base)
    if slot is None and base.startswith("nvme"):
        slot = next((n for d, n in names.items() if d.startswith(base + "n")), None)
    details = ", ".join(x for x in (doc.get("model_name"), doc.get("serial_number")) if x)
    return f"{slot or device} ({details})" if details else (slot or device)


def problems_of(doc):
    found = []
    if doc.get("smart_status", {}).get("passed") is False:
        found.append("the SMART health check FAILED")

    rotating = (doc.get("rotation_rate") or 0) > 0
    for attr in doc.get("ata_smart_attributes", {}).get("table", []):
        number, name = attr.get("id"), attr.get("name", "")
        if attr.get("when_failed") == "now":
            found.append(f"{name} is below its threshold")
        if number in ATA_COUNTERS:
            what, limit = ATA_COUNTERS[number]
            count = attr.get("raw", {}).get("value", 0)
            if count > limit:
                found.append(f"{count} {what}")
        if not rotating and number in SSD_LIFE_ATTRS and re.search("life|wear", name, re.I):
            if attr.get("value", 100) <= SSD_LIFE_MIN:
                found.append(f"{SSD_LIFE_MIN}% of its life left or less")

    nvme = doc.get("nvme_smart_health_information_log")
    if nvme:
        if nvme.get("critical_warning"):
            found.append(f"NVMe critical warning {nvme['critical_warning']:#04x}")
        if nvme.get("media_errors", 0) > NVME_MEDIA_ERRORS_MAX:
            found.append(f"{nvme['media_errors']} media errors")
        if nvme.get("available_spare", 100) < nvme.get("available_spare_threshold", 0):
            found.append("spare capacity is below its threshold")
        if nvme.get("percentage_used", 0) >= NVME_USED_MAX:
            found.append(f"{NVME_USED_MAX}% of its rated life used or more")

    limit = TEMP_MAX_HDD if rotating else TEMP_MAX_SSD
    if doc.get("temperature", {}).get("current", 0) >= limit:
        found.append(f"temperature at or above {limit} °C")
    return found


def seen_in(doc):
    """The values problems_of() judges, for --report."""
    seen = []
    passed = doc.get("smart_status", {}).get("passed")
    if passed is not None:
        seen.append("SMART check passed" if passed else "SMART check FAILED")
    temperature = doc.get("temperature", {}).get("current")
    if temperature is not None:
        seen.append(f"{temperature} °C")

    rotating = (doc.get("rotation_rate") or 0) > 0
    life = []  # some SSDs report it in more than one attribute: the lowest counts
    for attr in doc.get("ata_smart_attributes", {}).get("table", []):
        number, name = attr.get("id"), attr.get("name", "")
        if number in ATA_COUNTERS:
            seen.append(f"{attr.get('raw', {}).get('value', 0)} {ATA_COUNTERS[number][0]}")
        if not rotating and number in SSD_LIFE_ATTRS and re.search("life|wear", name, re.I):
            life.append(attr.get("value", 100))
    if life:
        seen.append(f"{min(life)}% of its life left")

    nvme = doc.get("nvme_smart_health_information_log")
    if nvme:
        seen.append(f"{nvme.get('percentage_used', 0)}% of its rated life used")
        seen.append(f"{nvme.get('media_errors', 0)} media errors")
        if "available_spare" in nvme:
            seen.append(f"{nvme['available_spare']}% spare capacity")
    return seen


LIMITS = (
    "Limits: "
    + ", ".join(f"{what} above {limit}" for what, limit in ATA_COUNTERS.values())
    + f"; SSD life left {SSD_LIFE_MIN}% or less; NVMe life used {NVME_USED_MAX}% or more;"
    + f" NVMe media errors above {NVME_MEDIA_ERRORS_MAX}; {TEMP_MAX_HDD} °C (hard disk) or {TEMP_MAX_SSD} °C (SSD)."
)

# ── Arguments ────────────────────────────────────────────────────────────────
# Only `/run disk-health <words>` passes any; a scheduled run has none.
unknown = [a for a in sys.argv[1:] if a != "--report"]
if unknown:
    print(f"disk-health: unknown argument {unknown[0]}. The only one is --report.")
    sys.exit(2)
report = "--report" in sys.argv[1:]

answer = host("sh", "-c", COLLECT)
docs = list(documents(answer.stdout))
if not docs:
    # No smartctl on this host, or no disk it can talk to: nothing to watch.
    if not answer.stderr.strip() or re.search("not found|no such file", answer.stderr, re.I):
        if report:
            print("No disk with SMART data was found.")
        sys.exit(0)
    print("disk-health: could not read SMART data:\n" + answer.stderr.strip())
    sys.exit(1)

names = slots()
lines = []    # the disks that need attention: what a normal run prints
shown = []    # every disk: what --report prints
for doc in docs:
    smartctl = doc.get("smartctl", {})
    messages = [m.get("string", "") for m in smartctl.get("messages", [])]
    if any(re.search("STANDBY|SLEEP", m) for m in messages):
        shown.append(f"{label(doc, names)}: asleep, not checked")
        continue  # asleep: left alone
    if "smart_status" not in doc and smartctl.get("exit_status", 0) & 0b110:
        lines.append(f"{label(doc, names)}: SMART data could not be read")
        shown.append("ATTENTION " + lines[-1])
        continue
    found = problems_of(doc)
    if found:
        lines.append(f"{label(doc, names)}: " + "; ".join(found))
    shown.append(("ATTENTION " if found else "") + f"{label(doc, names)}: " + ", ".join(seen_in(doc) or ["no values to judge"]))

if report:
    print("\n".join(sorted(shown, key=lambda line: line.removeprefix("ATTENTION "))))
    if lines:
        print("\nNeeds attention:\n" + "\n".join(sorted(lines)))
    print("\n" + LIMITS)
    sys.exit(1 if lines else 0)
if not lines:
    sys.exit(0)
print("\n".join(sorted(lines)))
sys.exit(1)
PY
