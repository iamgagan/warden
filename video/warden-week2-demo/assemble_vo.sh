#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

mksilence() {
  local dur="$1" out="$2"
  ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=mono" -t "$dur" "$out" -hide_banner -loglevel error
}

TMP=$(mktemp -d)
LIST="$TMP/concat.txt"
: > "$LIST"

# Initial silence before first section
mksilence 0.3 "$TMP/sil_lead.mp3"
echo "file '$TMP/sil_lead.mp3'" >> "$LIST"
echo "file '$(pwd)/vo/vo_00.mp3'" >> "$LIST"

# gap, seg pairs computed from measured durations + planned starts
declare -a GAPS=(0.407 0.475 0.465 0.435 0.471)
declare -a SEGS=(vo_01 vo_02 vo_03 vo_04 vo_05)

for i in "${!SEGS[@]}"; do
  mksilence "${GAPS[$i]}" "$TMP/sil_$i.mp3"
  echo "file '$TMP/sil_$i.mp3'" >> "$LIST"
  echo "file '$(pwd)/vo/${SEGS[$i]}.mp3'" >> "$LIST"
done

ffmpeg -y -f concat -safe 0 -i "$LIST" -c:a libmp3lame -q:a 2 voiceover.mp3 -hide_banner -loglevel error

# Pad to exactly 60s
ffmpeg -y -i voiceover.mp3 -af "apad=whole_dur=60" -c:a libmp3lame -q:a 2 voiceover-padded.mp3 -hide_banner -loglevel error
mv voiceover-padded.mp3 voiceover.mp3

rm -rf "$TMP"
ffprobe -v error -show_entries format=duration -of csv=p=0 voiceover.mp3
