#!/usr/bin/env bash
# 启动网页版；有 .venv 就用它（里面可能装了 PyPatchMatch / scikit-image）
set -euo pipefail
cd "$(dirname "$0")"
PY=python3
if [ -x .venv/bin/python ]; then PY=.venv/bin/python; fi
exec "$PY" web/server.py "$@"
