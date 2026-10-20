# Contributing to Pi Extensions

## Getting Started

1. Fork the repository.
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/pi-extensions.git
   cd pi-extensions
   ```
3. Create a branch for your changes:
   ```bash
   git checkout -b feature/my-extension
   ```

## Extension Structure

Each extension lives in `extensions/<name>/` and requires:

- `package.json` – must include a `"pi"` field with `"extensions"` array pointing to entry files:
  ```json
  {
    "name": "my-extension",
    "version": "1.0.0",
    "type": "module",
    "main": "./index.ts",
    "pi": {
      "extensions": ["./index.ts"]
    }
  }
  ```
- `index.ts` — default export function receiving an `ExtensionAPI` object. See `extensions/statusline-pi/index.ts` for reference.

Key coding patterns:
- Use `import type` for type-only imports (e.g., `ExtensionAPI`, `ExtensionContext`)
- Use `node:` prefix for Node.js built-in modules
- Wrap external calls (git, gh) in try/catch for error resilience
- Use `ctx.ui.notify("message", "info")` for user-facing alerts
- Expose commands via `pi.registerCommand(name, { description, handler })`

## Theme Format

Themes are JSON files in `themes/`. The schema:

- `$schema` — theme JSON schema URL (optional; `https://pi.dev/schemas/theme.schema.json`)
- `name` — unique theme identifier
- `appearance` — `dark` or `light` (optional; detected from colors when omitted)
- `vars` — reusable color variables referenced by name from `colors` and `export` (optional)
- `colors` — color token map (accent, borderMuted, error, text, mdHeading, mdLink, success, warning, etc.)
- `export` — HTML export colors: `pageBg`, `cardBg`, `infoBg` (optional)

Pi's schema is strict: any other top-level key (such as `displayName`) or unknown `colors` token fails validation.

See `themes/neon-green.json` and `themes/neon-green-light.json` for complete examples.

## Testing Your Changes

1. Install your local copy:
   ```bash
   npm run install-all
   ```
   Or test individual components:
   ```bash
   npm run install-extensions
   npm run install-themes
   ```
2. Reload Pi: type `/reload` in Pi.
3. Verify extensions work: run `/statusline-pi` to toggle footer.
4. Verify themes: select from Pi's `/settings`.

## Pull Request Checklist

Before submitting, ensure:

- [ ] `npm run install-all` completes without errors
- [ ] Extensions load correctly in Pi (`/reload`)
- [ ] Commands work as expected (`/statusline-pi`, `/statusline-refresh`)
- [ ] New extensions include a `package.json` with the `pi.extensions` field
- [ ] New themes follow the existing JSON schema
- [ ] README.md is updated with new extensions/themes and their usage
- [ ] Code follows existing patterns (error resilience, `node:` prefix, typed imports)

## Code Style

- TypeScript with strict types
- Use `import type` for type-only declarations
- Prefer `node:` protocol for Node built-ins
- Handle errors gracefully (try/catch, fallback values)
- Use `ctx.ui.notify` for user feedback rather than console

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
