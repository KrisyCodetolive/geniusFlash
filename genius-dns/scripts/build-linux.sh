#!/usr/bin/env bash
# Construit l'exécutable Linux de l'agent : dist/geniusdns-agent-linux-<arch> (+ .sha256).
# Prérequis : .venv avec `pip install -e . pyinstaller`. Lancer depuis genius-dns/.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="geniusdns-agent-linux-$(uname -m)"
.venv/bin/pyinstaller --onefile --clean --noconfirm \
  --name "$NAME" \
  --paths src \
  --specpath build \
  --workpath build/work \
  --distpath dist \
  packaging/agent_entry.py

(cd dist && sha256sum "$NAME" > "$NAME.sha256")
echo "OK : dist/$NAME"
