# fm-proxy (vendored)

Upstream: [gregbarbosa/fm-proxy](https://github.com/gregbarbosa/fm-proxy) (MIT).

Shipped as `fm-proxy.cjs` (extension package is ESM). Bundled in **apple-fm-pi** to:

- Flatten Pi/OpenAI tool schemas so `fm serve` accepts them (fixes **400 Invalid tool definition**).
- Repair `prompt_tokens` in usage for Pi's context gauge.
- Add CORS and OpenAI-shaped errors.

PCC still requires **foreground** `fm serve` — use `/apple-fm-pi launch-terminal` or `bin/fm-launch.sh`.