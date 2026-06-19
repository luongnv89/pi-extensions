import {
	streamSimpleOpenAICompletions,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { fixOpenAIChatPayload } from "./fm-tools.js";

/** Pi stream handler: flatten tools in-flight, then delegate to openai-completions. */
export function streamAppleFm(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return streamSimpleOpenAICompletions(model as Model<"openai-completions">, context, {
		...options,
		onPayload: async (payload, m) => {
			const { payload: fixed } = fixOpenAIChatPayload(payload);
			let body = fixed as Record<string, unknown>;
			if (m.id === "system" && typeof body.max_tokens === "number") {
				body = { ...body, max_tokens: Math.min(body.max_tokens, 1024) };
			}
			const next = await options?.onPayload?.(body, m);
			return next !== undefined ? fixOpenAIChatPayload(next).payload : body;
		},
	});
}