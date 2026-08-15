#!/bin/sh
# Sample total CPU used by every Chromium process over a window.
#
# There is no ps/top on this box, so this reads utime+stime straight out of
# /proc/<pid>/stat (fields 14 and 15, in clock ticks) and diffs them. Summing
# across ALL chromium pids matters: the renderer runs my JavaScript, but the
# GPU/compositor process is where a `filter: blur()` on an animated element
# actually gets paid for, and attributing only the renderer would let the most
# expensive layer hide.
#
# Usage: measure-cpu.sh <seconds> <label>

WINDOW="${1:-5}"
LABEL="${2:-sample}"
HZ=$(getconf CLK_TCK)

sample() {
	total=0
	for p in /proc/[0-9]*; do
		comm=$(cat "$p/comm" 2>/dev/null) || continue
		case "$comm" in
			*chrome*|*chromium*|*headless*) ;;
			*) continue ;;
		esac
		stat=$(cat "$p/stat" 2>/dev/null) || continue
		# Skip past comm, which may itself contain spaces, by cutting at ") ".
		rest=${stat#*) }
		u=$(echo "$rest" | cut -d' ' -f12)
		s=$(echo "$rest" | cut -d' ' -f13)
		total=$((total + u + s))
	done
	echo "$total"
}

a=$(sample)
sleep "$WINDOW"
b=$(sample)

ticks=$((b - a))
# CPU% of one core = ticks / HZ / window * 100
pct=$(awk -v t="$ticks" -v hz="$HZ" -v w="$WINDOW" 'BEGIN { printf "%.1f", (t/hz/w)*100 }')
printf '%-28s %6s%% of one core  (%s ticks over %ss)\n' "$LABEL" "$pct" "$ticks" "$WINDOW"
