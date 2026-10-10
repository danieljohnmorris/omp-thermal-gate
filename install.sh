#!/usr/bin/env sh
# Install the thermal gate into omp's auto-discovered extensions folder.
# Copies index.ts only; no configuration or secrets are written anywhere.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dest="${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}/thermal-gate"
mkdir -p "$dest"
cp "$here/index.ts" "$dest/index.ts"
echo "installed: $dest/index.ts"
echo "set SPARKDASH_URL and SPARKDASH_TOKEN in your shell environment, then restart omp."
