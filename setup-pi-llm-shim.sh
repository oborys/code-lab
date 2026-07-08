#!/usr/bin/env bash
set -euo pipefail

if [ -z "${LLM_BASE_URL:-}" ]; then
  echo "ERROR: LLM_BASE_URL is not set." >&2
  exit 1
fi

if [ -z "${LLM_API_KEY:-}" ]; then
  echo "ERROR: LLM_API_KEY is not set." >&2
  exit 1
fi

mkdir -p "$HOME/.pi/agent" "$HOME/pi-shim"

cat > "$HOME/.pi/agent/models.json" <<'EOF'
{
  "providers": {
    "cisco-llm-proxy": {
      "baseUrl": "http://127.0.0.1:11500",
      "api": "openai-completions",
      "apiKey": "shim-local-only",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-5-nano",
          "name": "GPT-5 Nano (via shim)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 400000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
EOF

chmod 600 "$HOME/.pi/agent/models.json"

curl -fsSL https://raw.githubusercontent.com/oborys/code-lab/main/pi-stream-shim.mjs \
  -o "$HOME/pi-shim/pi-stream-shim.mjs"

python3 - <<'PY'
from pathlib import Path

p = Path.home() / "pi-shim/pi-stream-shim.mjs"
s = p.read_text()
s = s.replace(
"""  const authHeader =
    req.headers.authorization ||
    (FALLBACK_KEY ? `Bearer ${FALLBACK_KEY}` : undefined);""",
"""  const authHeader =
    (FALLBACK_KEY ? `Bearer ${FALLBACK_KEY}` : undefined) ||
    req.headers.authorization;""",
)
p.write_text(s)
PY

echo "Configured ~/.pi/agent/models.json"
echo "Downloaded and patched ~/pi-shim/pi-stream-shim.mjs"
echo
echo "Start the shim in a dedicated terminal with:"
echo "  PI_SHIM_PORT=11500 node ~/pi-shim/pi-stream-shim.mjs"
