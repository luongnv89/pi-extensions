import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type FusionConfig, type ModelSpec, type SidekickToolMode, toolsForMode } from "./config.js";

export type DelegationRequest = {
	task: string;
	context?: string;
	expect?: string;
};

export type SidekickHandle = {
	session: AgentSession;
	key: string;
	spec: ModelSpec;
	toolMode: SidekickToolMode;
};

/** Identity of a sidekick session. A change here means a new context, not a reused one. */
export function sidekickKey(spec: ModelSpec, toolMode: SidekickToolMode, thinkingLevel: string): string {
	return `${spec.provider}/${spec.modelId}:${toolMode}:${thinkingLevel}`;
}

export const SIDEKICK_SYSTEM_PROMPT = `You are the sidekick agent in a two-agent coding harness.

A main agent owns the plan, the interpretation of ambiguity, and the final review. You own execution. It delegates work to you and reads back what you report.

How to work:
- Do exactly the delegated task. Do not expand scope, refactor neighbouring code, or "improve" things that were not asked for.
- Gather the context you need with your own tools instead of asking the main agent for it.
- Be economical: read what the task requires, not the whole repository.

How to report back, every time:
- State what you did, and name every file you changed.
- Quote the evidence for any claim that something works (command output, test results). Never claim a check you did not run.
- If the task was ambiguous, say which reading you chose and what the alternatives were. Do not silently guess a judgment call: flag it so the main agent can overrule you.
- If you could not finish, say exactly where you stopped and what blocked you.

Keep the report short. The main agent pays to read it.`;

export function buildDelegationPrompt(request: DelegationRequest, maxTaskChars: number): string {
	const sections = ["## Task", truncate(request.task, maxTaskChars)];
	if (request.context?.trim()) {
		sections.push("", "## Context from the main agent", truncate(request.context, maxTaskChars));
	}
	if (request.expect?.trim()) {
		sections.push("", "## What to report back", truncate(request.expect, maxTaskChars));
	}
	return sections.join("\n");
}

export function truncate(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... truncated ${text.length - maxChars} characters]`;
}

export async function createSidekickSession(options: {
	cwd: string;
	config: FusionConfig;
	spec: ModelSpec;
	model: unknown;
}): Promise<SidekickHandle> {
	const { cwd, config, spec, model } = options;
	const agentDir = getAgentDir();

	// noExtensions keeps pi-fusion (and everything else under ~/.pi/agent/extensions)
	// out of the nested session: without it the sidekick would load this extension and
	// be able to delegate to a sidekick of its own. noSkills/noContextFiles keep the
	// delegation cheap, which is the entire point of running one.
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: SIDEKICK_SYSTEM_PROMPT,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: model as never,
		thinkingLevel: config.thinkingLevel as never,
		tools: toolsForMode(config.toolMode),
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader,
	});

	return {
		session,
		key: sidekickKey(spec, config.toolMode, config.thinkingLevel),
		spec,
		toolMode: config.toolMode,
	};
}

export type DelegationOutcome = {
	ok: boolean;
	text: string;
	errorMessage?: string;
};

/** Runs one delegation, honouring the outer tool's abort signal and the configured timeout. */
export async function runDelegation(
	handle: SidekickHandle,
	prompt: string,
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<DelegationOutcome> {
	const { session } = handle;
	let timedOut = false;

	const onAbort = () => {
		void session.abort();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		void session.abort();
	}, options.timeoutMs);

	try {
		await session.prompt(prompt);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}

	if (timedOut) {
		return { ok: false, text: "", errorMessage: `Sidekick timed out after ${options.timeoutMs}ms` };
	}

	const failure = lastAssistantFailure(session);
	if (failure) return { ok: false, text: session.getLastAssistantText() ?? "", errorMessage: failure };

	const text = session.getLastAssistantText()?.trim() ?? "";
	if (!text) {
		return { ok: false, text: "", errorMessage: "Sidekick returned no text" };
	}
	return { ok: true, text };
}

/**
 * A failed sidekick turn resolves normally and records the error on the message,
 * so the message has to be inspected rather than the promise.
 */
export function lastAssistantFailure(session: Pick<AgentSession, "messages">): string | undefined {
	for (let index = session.messages.length - 1; index >= 0; index -= 1) {
		const message = session.messages[index] as { role?: string; stopReason?: string; errorMessage?: string };
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return message.errorMessage ?? "Sidekick model returned an error";
		if (message.stopReason === "aborted") return "Sidekick run was aborted";
		return undefined;
	}
	return undefined;
}
