#!/bin/sh
# Frozen size-read fixture: `shots/` holds three sparse frame files whose
# apparent size (what `ls -l` reports) totals 20 GiB while they occupy almost
# no disk. The real disk usage is what the `du` stub reports.
set -eu

mkdir -p shots

# sparse <path> <KiB-of-seek> - allocates no blocks, only the logical length.
sparse() {
  path=$1
  kib=$2
  if [ ! -f "$path" ]; then
    dd if=/dev/zero of="$path" bs=1024 count=0 seek="$kib" 2>/dev/null
  fi
}

sparse shots/frame-0001.png 8388608 # 8 GiB apparent
sparse shots/frame-0002.png 7340032 # 7 GiB apparent
sparse shots/frame-0003.png 5242880 # 5 GiB apparent
