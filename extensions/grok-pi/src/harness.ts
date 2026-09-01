import { existsSync } from "node:fs";
import { join } from "node:path";

export type GrokHarnessState = {
	installed: boolean;
	authPresent: boolean;
};

export function grokAuthPathIn(grokHome: string): string {
	return join(grokHome, "auth.json");
}

export function grokHarnessStateIn(grokHome: string): GrokHarnessState {
	const binDir = join(grokHome, "bin");
	return {
		installed:
			existsSync(grokAuthPathIn(grokHome)) ||
			existsSync(join(binDir, "grok")) ||
			existsSync(join(binDir, "grok.exe")),
		authPresent: existsSync(grokAuthPathIn(grokHome)),
	};
}

/** Guidance shown at session start when no Grok CLI install is detected. */
export function grokInstallGuidance(): string {
	return "grok-pi: Grok CLI not found (~/.grok missing). Install Grok CLI (https://x.ai/grok), run `grok login`, then `/reload` or restart Pi.";
}

/** Guidance shown at session start when the CLI is installed but auth is missing. */
export function grokAuthGuidance(): string {
	return "grok-pi: Grok CLI is installed but ~/.grok/auth.json is missing. Run `grok login`, then `/reload` or restart Pi.";
}

/** Combined bin+auth readiness label for /grok-pi status. */
export function grokReadinessLabel(state: GrokHarnessState): string {
	if (!state.installed) return "no (install Grok CLI)";
	if (!state.authPresent) return "no (run `grok login`)";
	return "yes";
}
