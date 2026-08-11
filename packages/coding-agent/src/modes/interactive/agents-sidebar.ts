/**
 * AgentsSidebar — persistent left rail for the interactive chat.
 *
 * Shows the same unified agent/resume roster as the full-screen agents view
 * (live sessions + saved sessions + heartbeats), rendered compactly, and
 * lets the user switch to another session in place via
 * AgentConnection.switchSession (already handled by interactive-mode's
 * session_replaced listener), kill live agents, or refresh.
 *
 * The component is rendered by the TUI's left-rail compositor; keyboard input
 * is routed here by InteractiveMode through a TUI input listener while the
 * sidebar is focused.
 */

import { getKeybindings, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	buildAgentsViewRows,
	buildUnifiedSessionIndex,
	reconcileUnifiedSessions,
	sectionTitle,
	shouldShowAgentsViewSession,
	type AgentsViewRow,
} from "../agents-view/agents-view-state.js";
import { DaemonClient } from "../daemon/daemon-client.js";
import { listDaemonHeartbeats } from "../daemon/heartbeat-catalog.js";
import {
	listDaemonSavedSessions,
	type DaemonSavedSessionCatalogContext,
} from "../daemon/saved-session-catalog.js";
import type { AgentConnectionHeartbeat, AgentConnectionSavedSessionInfo } from "../agent-connection/types.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import { theme } from "./theme/theme.js";
import { workingIconFrame } from "./theme/working-icon.js";

export interface AgentsSidebarOptions {
	daemonSocketPath: string;
	/** Cwd + optional session dir for scoping saved-session listing. */
	cwd: string;
	sessionDir?: string;
	/** Live current session id (highlighted in the roster). */
	getCurrentSessionId: () => string | undefined;
	/** Fired when the user confirms a row: open/switch to that session. */
	onOpenSession: (summary: SessionSummary) => void;
	/** Fired when the user confirms the row that is already the current session. */
	onCurrentSession?: () => void;
	/** Fired on dispose so the owner can tear down the rail. */
	onDispose?: () => void;
	/** Terminal height for windowing; defaults to process.stdout.rows. */
	getRows?: () => number;
}

const POLL_INTERVAL_MS = 2000;
const SAVED_POLL_INTERVAL_MS = 10000;

export class AgentsSidebar implements Component {
	// Component contract
	render(width: number): string[] {
		return this.renderRows(width);
	}
	invalidate(): void {
		/* nothing cached */
	}

	private readonly client: DaemonClient;
	private readonly options: AgentsSidebarOptions;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private savedTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	private activeSessionId: string | undefined;

	private sessions: SessionSummary[] = [];
	private savedSessions: AgentConnectionSavedSessionInfo[] = [];
	private heartbeats: AgentConnectionHeartbeat[] = [];
	private rows: AgentsViewRow[] = [];
	private selectableRows: AgentsViewRow[] = [];
	private selectedIndex = 0;
	private error: string | undefined;
	private lastErrorAt = 0;
	private pulseFrame = 0;

	constructor(options: AgentsSidebarOptions) {
		this.options = options;
		this.client = new DaemonClient(options.daemonSocketPath);
	}

	/** Connect and start polling. Call once, after the TUI rail is set. */
	async start(): Promise<void> {
		try {
			await this.client.connect();
			await this.client.waitForHello();
			await Promise.all([this.refresh(), this.refreshSavedSessions(), this.refreshHeartbeats()]);
		} catch (error) {
			this.setError(error);
		}
		this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
		this.savedTimer = setInterval(
			() => void Promise.all([this.refreshSavedSessions(), this.refreshHeartbeats()]),
			SAVED_POLL_INTERVAL_MS,
		);
		this.pollTimer.unref?.();
		this.savedTimer.unref?.();
	}

	/** Current daemon active session id, if connected. */
	getActiveSessionId(): string | undefined {
		return this.activeSessionId;
	}

	/** Last non-transient error message, or undefined when healthy. */
	getLastError(): string | undefined {
		return this.error;
	}

	/** Force an immediate refresh of the live roster (list + saved + heartbeats). */
	async refreshNow(): Promise<void> {
		await Promise.all([this.refresh(), this.refreshSavedSessions(), this.refreshHeartbeats()]);
	}

	private setError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		// Coalesce identical errors so the rail doesn't thrash on a dead daemon.
		if (message !== this.error || Date.now() - this.lastErrorAt > 5000) {
			this.error = message;
			this.lastErrorAt = Date.now();
		}
	}

	private getSavedSessionContext(): DaemonSavedSessionCatalogContext {
		return { cwd: this.options.cwd, sessionDir: this.options.sessionDir };
	}

	private async refresh(): Promise<void> {
		if (this.disposed || !this.client.isConnected) return;
		try {
			const response = await this.client.request({ type: "list" });
			if (this.disposed || !response.success) {
				if (!response.success) this.setError(response.error ?? "list failed");
				return;
			}
			const data = response.data as { sessions: SessionSummary[]; busyClientOwnedSessionCount?: number };
			this.sessions = data.sessions ?? [];
			this.error = undefined;
			this.reconcile();
			// Also pick up the active-session id of whatever we're attached to.
			this.activeSessionId =
				data.sessions.find((s) => s.sessionId === this.options.getCurrentSessionId())?.activeSessionId ??
				this.activeSessionId;
		} catch (error) {
			this.setError(error);
		}
	}

	private async refreshSavedSessions(): Promise<void> {
		if (this.disposed || !this.client.isConnected) return;
		try {
			this.savedSessions = await listDaemonSavedSessions(this.client, this.getSavedSessionContext(), "all");
			this.reconcile();
		} catch (error) {
			this.setError(error);
		}
	}

	private async refreshHeartbeats(): Promise<void> {
		if (this.disposed || !this.client.isConnected) return;
		try {
			this.heartbeats = await listDaemonHeartbeats(this.client);
			this.reconcile();
		} catch {
			/* heartbeats are optional; keep last known */
		}
	}

	private reconcile(): void {
		const visible = this.sessions.filter((s) => shouldShowAgentsViewSession(s));
		const records = reconcileUnifiedSessions(visible, this.savedSessions, this.heartbeats);
		buildUnifiedSessionIndex(records);
		this.rows = buildAgentsViewRows(records);
		this.selectableRows = this.rows.filter((row) => row.selectable);
		if (this.selectedIndex >= this.selectableRows.length) {
			this.selectedIndex = Math.max(0, this.selectableRows.length - 1);
		}
	}

	/** Mark the current session (after a session_replaced switch). */
	updateCurrentSession(sessionId: string | undefined): void {
		if (sessionId !== this.options.getCurrentSessionId()) {
			// no external state to update; activeSessionId refresh happens on poll
		}
	}

	// ---- keyboard ----

	/** Handle one input chunk while the sidebar has focus. Returns true if consumed. */
	handleInput(data: string): boolean {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			if (this.selectableRows.length > 0) {
				this.selectedIndex = (this.selectedIndex - 1 + this.selectableRows.length) % this.selectableRows.length;
			}
			this.advancePulse();
			return true;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.selectableRows.length > 0) {
				this.selectedIndex = (this.selectedIndex + 1) % this.selectableRows.length;
			}
			this.advancePulse();
			return true;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 10);
			this.advancePulse();
			return true;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.selectableRows.length - 1, this.selectedIndex + 10);
			this.advancePulse();
			return true;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.openSelected();
			return true;
		}
		return false;
	}

	/** Kill the selected live agent (daemon kill command). */
	async killSelected(): Promise<boolean> {
		const row = this.selectableRows[this.selectedIndex];
		if (!row?.summary?.activeSessionId) return false;
		try {
			const response = await this.client.request({
				type: "kill",
				activeSessionId: row.summary.activeSessionId,
			});
			if (!response.success) {
				this.setError(response.error ?? "kill failed");
				return false;
			}
			await this.refresh();
			return true;
		} catch (error) {
			this.setError(error);
			return false;
		}
	}

	/** Open/switch to the selected session. */
	openSelected(): void {
		const row = this.selectableRows[this.selectedIndex];
		if (!row) return;
		const summary = row.summary;
		const current = this.options.getCurrentSessionId();
		if (current && summary.sessionId === current) {
			this.options.onCurrentSession?.();
			return; // already here
		}
		this.options.onOpenSession(summary);
	}

	getSelectedSummary(): SessionSummary | undefined {
		return this.selectableRows[this.selectedIndex]?.summary;
	}

	// ---- rendering ----

	private renderRows(width: number): string[] {
		const rows = this.getRows();
		// Full terminal height so the rail column runs to the bottom row; a
		// rows-1 rail leaves the last visible row with a blank rail slot.
		const maxLines = Math.max(4, rows);
		this.advancePulse();
		// The last column is the right-edge rail (pi-harness style separator).
		const innerWidth = Math.max(4, width - 1);
		const out: string[] = [];

		// header
		out.push(theme.bold(theme.fg("accent", truncateToWidth(" agents", innerWidth))));
		out.push(theme.fg("borderMuted", "─".repeat(Math.max(0, innerWidth))));

		if (this.error) {
			out.push(theme.fg("error", truncateToWidth(` ! ${this.error}`, innerWidth)));
		}

		const total = this.selectableRows.length;
		// The visible window must fit `maxLines` exactly; rows AND the section
		// headers that introduce them count against the budget. Without this, a
		// roster spanning many sections renders more lines than the terminal
		// and the TUI rail compositor appends the excess to the frame, shifting
		// the whole window upward (and slicing raw ANSI mid-sequence).
		const bodyBudget = Math.max(0, maxLines - out.length);
		// Leave one line for the "↓ N more" indicator whenever the list
		// overflows; when the whole list fits, the reserved slot is simply
		// unused padding.
		const windowBudget = Math.max(1, bodyBudget - 1);
		// How many lines rows [from, to) render, counting section headers.
		const windowLines = (from: number, to: number): number => {
			let lines = 0;
			let section: string | undefined;
			for (let i = from; i < to; i++) {
				if (this.selectableRows[i]!.section !== section) {
					lines += 1;
					section = this.selectableRows[i]!.section;
				}
				lines += 1;
			}
			return lines;
		};
		// Center the selection, then slide the start forward until the
		// selection (with its section header) fits, so the focused row is
		// always visible.
		let start = Math.max(0, Math.min(this.selectedIndex - Math.floor(windowBudget / 2), Math.max(0, total - 1)));
		while (start < this.selectedIndex && windowLines(start, this.selectedIndex + 1) > windowBudget) {
			start += 1;
		}
		let end = start;
		let used = 0;
		let currentSection: string | undefined;
		for (let i = start; i < total; i++) {
			const row = this.selectableRows[i];
			const add = (row.section !== currentSection ? 1 : 0) + 1;
			if (used + add > windowBudget) break;
			currentSection = row.section;
			used += add;
			end = i + 1;
		}

		currentSection = undefined;
		for (let i = Math.max(0, start); i < end; i++) {
			const row = this.selectableRows[i];
			if (row.section !== currentSection) {
				currentSection = row.section;
				out.push(theme.fg("dim", truncateToWidth(` ${sectionTitle(row.section)}`, innerWidth)));
			}
			out.push(this.renderRow(row, i === this.selectedIndex, innerWidth));
		}
		if (end < total) {
			out.push(theme.fg("muted", truncateToWidth(` ↓ ${total - end} more`, innerWidth)));
		}

		// The rail character itself is drawn in the reverse-video colour (the
		// light foreground), not the whole cell inverted — so it reads as a
		// clean light `│` line rather than a solid block.
		const rail = theme.fg("text", "│");
		while (out.length < maxLines) {
			// Pad to full rendered width so the rail is a continuous column.
			out.push(" ".repeat(innerWidth));
		}
		// Append the right-edge rail to every row (header, sections, blanks),
		// padding short lines (header text, section titles) to the full content
		// width first so the rail always aligns at the sidebar's right edge.
		return out.map((line) => {
			const clipped = truncateToWidth(line, innerWidth, "", false);
			return clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + rail;
		});
	}

	private renderRow(row: AgentsViewRow, selected: boolean, width: number): string {
		const indent = "  ".repeat(Math.min(4, row.depth));
		const isRunning = row.section === "running";
		const icon = isRunning
			? theme.bold(theme.fg("mdLink", workingIconFrame(this.pulseFrame)))
			: row.section === "idle"
				? theme.fg("warning", "●")
				: theme.fg("dim", "✓");
		const isCurrent = row.summary.sessionId === this.options.getCurrentSessionId();
		const labelColor = row.depth > 0 ? (isCurrent ? "text" : "muted") : isCurrent ? "text" : "text";
		let label = theme.fg(labelColor, row.title);
		if (isCurrent && !selected) {
			label = theme.bold(label);
		}
		const title = truncateToWidth(`${indent}${icon} ${label}`, width, "", false);
		// Pad to full width so the selection background covers the whole row.
		const padded = title + " ".repeat(Math.max(0, width - visibleWidth(title)));
		if (selected) {
			return theme.getSelectionBackgroundColor()(padded);
		}
		return padded;
	}

	// ---- lifecycle ----

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.savedTimer) clearInterval(this.savedTimer);
		try {
			this.client.close();
		} catch {
			/* ignore */
		}
		this.options.onDispose?.();
	}

	private getRows(): number {
		return this.options.getRows?.() ?? process.stdout.rows ?? 24;
	}

	private advancePulse(): void {
		this.pulseFrame = (this.pulseFrame + 1) % 4;
	}
}
