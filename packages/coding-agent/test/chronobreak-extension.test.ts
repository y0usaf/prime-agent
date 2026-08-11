/**
 * Validation for the user-level chronobreak extension
 * (~/.prime/agent/extensions/chronobreak.ts): loads the real file, drives
 * message events through the ExtensionRunner, and asserts detect -> abort ->
 * scrub-at-repetition-start behavior (no re-injection, no strike limit).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { loadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

const EXT_PATH = path.join(os.homedir(), ".prime/agent/extensions/chronobreak.ts");

const SENTENCE = "Let me check the system mtime and module import once more. ";
const PREFIX = "Here is my analysis of the failure and the plan to fix it going forward. ";
const SCRUB_MARKER = "[chronobreak: repeated output truncated]";

function assistantMessage(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}

function scrubbedText(replacement: unknown): string {
	return (replacement as { content: Array<{ type: string; text: string }> }).content
		.map((c) => c.text)
		.join("\n");
}

describe("chronobreak extension", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let abortCalls: number;
	let sentMessages: Array<{ content: unknown; options: unknown }>;
	let runner: ExtensionRunner;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronobreak-test-"));
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
		abortCalls = 0;
		sentMessages = [];

		const result = await loadExtensions([EXT_PATH], tempDir);
		expect(result.errors).toEqual([]);
		expect(result.extensions.length).toBe(1);

		runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		const actions: ExtensionActions = {
			sendMessage: () => {},
			sendUserMessage: (content, options) => {
				sentMessages.push({ content, options });
			},
			appendEntry: () => {},
			setSessionName: () => {},
			getSessionName: () => undefined,
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
			refreshTools: () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => "off",
			setThinkingLevel: () => {},
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			getSignal: () => undefined,
			abort: () => {
				abortCalls++;
			},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		};
		runner.bindCore(actions, contextActions);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function streamMessage(text: string) {
		const message = assistantMessage(text);
		await runner.emit({ type: "message_start", message });
		await runner.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message } as never,
		});
		return message;
	}

	it("aborts when the same sentence repeats >= 3 times in one message", async () => {
		await streamMessage(SENTENCE.repeat(4));
		expect(abortCalls).toBe(1);
	});

	it("does not abort on normal, varied output", async () => {
		await streamMessage(
			"First I will read the file. Then I will edit the function. Finally I will run the tests to confirm the fix.",
		);
		expect(abortCalls).toBe(0);
	});

	it("does not abort on scattered (non-consecutive) code mentions — a false-positive guard", async () => {
		// The same normalized fragment (a code guard clause) appearing at
		// separate points is NOT a loop: the model is legitimately discussing
		// code. Only a back-to-back run should be cut.
		const guard = "if (event.message.role !== \"assistant\") return;";
		await streamMessage(
			"First I will wire message_start: " + guard +
			" Then message_update uses the same guard: " + guard +
			" Finally message_end also checks it: " + guard,
		);
		expect(abortCalls).toBe(0);
	});

	it("does not abort on scattered repeated sentences, only on a consecutive run", async () => {
		await streamMessage(
			SENTENCE + "First I will add a step. " + SENTENCE + "Then I will refine it. " + SENTENCE,
		);
		expect(abortCalls).toBe(0);
	});

	it("scrubs back to where the repetition begins, keeping the first occurrence", async () => {
		const message = await streamMessage(SENTENCE.repeat(4));
		const replacement = await runner.emitMessageEnd({ type: "message_end", message });
		expect(replacement).toBeDefined();
		const text = scrubbedText(replacement);
		// first occurrence kept, repetitions dropped, marker appended
		expect(text.startsWith(SENTENCE.trimEnd())).toBe(true);
		expect(text.split("Let me check the system mtime").length - 1).toBe(1);
		expect(text.endsWith(SCRUB_MARKER)).toBe(true);
	});

	it("preserves the clean prefix before the loop", async () => {
		const message = await streamMessage(PREFIX + SENTENCE.repeat(3));
		expect(abortCalls).toBe(1);
		const replacement = await runner.emitMessageEnd({ type: "message_end", message });
		const text = scrubbedText(replacement);
		// prefix + first occurrence kept together
		expect(text.startsWith(PREFIX + SENTENCE.trimEnd())).toBe(true);
		expect(text.split("Let me check the system mtime").length - 1).toBe(1);
		expect(text.endsWith(SCRUB_MARKER)).toBe(true);
	});

	it("catches boundary-less periodic repetition and keeps a short prefix", async () => {
		// no sentence punctuation or newlines: the segment tier sees one giant
		// chunk, so only the periodic tier can catch this
		const phrase = "loop marker alpha beta gamma "; // 29 chars, no boundaries
		const text = phrase.repeat(160); // 4640 chars of pure repetition
		const message = await streamMessage(text);
		expect(abortCalls).toBe(1);
		const replacement = await runner.emitMessageEnd({ type: "message_end", message });
		const scrub = scrubbedText(replacement);
		expect(scrub.endsWith(SCRUB_MARKER)).toBe(true);
		expect(scrub.length).toBeLessThan(text.length / 4);
	});

	it("does not re-inject anything into the session on agent_end", async () => {
		const message = await streamMessage(SENTENCE.repeat(4));
		await runner.emitMessageEnd({ type: "message_end", message });
		await runner.emit({ type: "agent_end", messages: [] } as never);
		// chronobreak scrubs and aborts; it never writes a follow-up nudge
		// (or the repeated sample) back into session context.
		expect(sentMessages.length).toBe(0);
	});

	it("aborts + scrubs on every loop with no strike limit", async () => {
		// far more than the old 3-strike give-up threshold
		for (let i = 0; i < 6; i++) {
			const message = await streamMessage(SENTENCE.repeat(4));
			expect(abortCalls).toBe(i + 1);
			const replacement = await runner.emitMessageEnd({ type: "message_end", message });
			expect(scrubbedText(replacement).endsWith(SCRUB_MARKER)).toBe(true);
			await runner.emit({ type: "agent_end", messages: [] } as never);
		}
		// every loop is cut, always — no per-turn give-up, no reinjection
		expect(abortCalls).toBe(6);
		expect(sentMessages.length).toBe(0);
	});
});
