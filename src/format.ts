import {
	type AskWait,
	commitRecordText,
	commitScopeText,
	dueAtTime,
	explanationText,
	goalLines,
	type TodoItem,
	type TodoMoreState,
	type TodoPhase,
	type TodoStatus,
	unexplainedItems,
} from "./state.ts";

const isOpen = (status: TodoStatus): boolean => status === "pending" || status === "in_progress";
const isClosed = (status: TodoStatus): boolean => status === "completed" || status === "abandoned";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function formatDateTime(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatClock(ms: number, now: number): string {
	const date = new Date(ms);
	const ref = new Date(now);
	const sameDay = date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth() && date.getDate() === ref.getDate();
	return sameDay ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : formatDateTime(ms);
}

export function currentTimeLine(now: number): string {
	return `Current time: ${formatDateTime(now)}`;
}

export function itemTimeSummary(
	item: TodoItem,
	now: number,
	waits: readonly AskWait[] = [],
	detail: "inline" | "full" = "inline",
): string | undefined {
	const startedAt =
		item.timestamps?.startedAt ??
		(item.status === "in_progress" && item.time.kind === "estimated" ? (item.time.runningSince ?? undefined) : undefined);
	switch (item.status) {
		case "in_progress": {
			const parts: string[] = [];
			if (startedAt !== undefined) parts.push(`started ${formatClock(startedAt, now)}`);
			if (item.time.kind === "missing") {
				parts.push("no time estimate yet: add one with ESTIMATE");
			} else {
				const due = dueAtTime(item.time, now, waits);
				if (due !== undefined) {
					parts.push(`due by ${formatClock(due, now)}${now > due ? " (overdue)" : ""}`);
				}
			}
			return parts.length > 0 ? parts.join(", ") : undefined;
		}
		case "pending": {
			const pausedAt = item.timestamps?.pausedAt;
			const paused = pausedAt !== undefined || (item.time.kind === "estimated" && item.time.elapsedMs > 0);
			const parts: string[] = [];
			if (paused) {
				if (detail === "full" && startedAt !== undefined) parts.push(`started ${formatClock(startedAt, now)}`);
				parts.push(
					pausedAt !== undefined
						? detail === "full"
							? `paused ${formatClock(pausedAt, now)} (deadline resumes on START)`
							: `paused ${formatClock(pausedAt, now)}`
						: "paused",
				);
			} else if (detail === "full" && item.time.kind === "estimated") {
				parts.push("not started (deadline set on START)");
			}
			if (item.time.kind === "missing") parts.push("no time estimate yet: add one with ESTIMATE");
			return parts.length > 0 ? parts.join(", ") : undefined;
		}
		case "completed": {
			const completedAt = item.timestamps?.completedAt;
			const parts: string[] = [];
			if (detail === "full" && startedAt !== undefined) parts.push(`started ${formatClock(startedAt, now)}`);
			if (completedAt !== undefined) parts.push(`completed ${formatClock(completedAt, now)}`);
			return parts.length > 0 ? parts.join(", ") : undefined;
		}
		case "abandoned": {
			const abandonedAt = item.timestamps?.abandonedAt;
			const parts: string[] = [];
			if (detail === "full" && startedAt !== undefined) parts.push(`started ${formatClock(startedAt, now)}`);
			if (abandonedAt !== undefined) parts.push(`abandoned ${formatClock(abandonedAt, now)}`);
			return parts.length > 0 ? parts.join(", ") : undefined;
		}
		default: {
			const unreachable: never = item.status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

function unestimatedItems(state: Extract<TodoMoreState, { kind: "list" }>): TodoItem[] {
	return state.phases.flatMap((phase) => phase.items.filter((item) => isOpen(item.status) && item.time.kind === "missing"));
}

function goalSection(state: Extract<TodoMoreState, { kind: "list" }>): string[] {
	if (state.goal.kind === "set") return ["Goal:", ...goalLines(state.goal.goal).map((line) => `  ${line}`)];
	return ["Goal: none yet — put GOAL first in the next Todo document."];
}

function overallLine(phases: readonly TodoPhase[]): string {
	const items = phases.flatMap((phase) => phase.items);
	const completed = items.filter((item) => item.status === "completed").length;
	const abandoned = items.filter((item) => item.status === "abandoned").length;
	const closed = completed + abandoned;
	const open = items.length - closed;
	const breakdown = abandoned > 0 ? ` (${completed} completed, ${abandoned} abandoned)` : "";
	return `Overall: ${closed}/${items.length} done${breakdown}, ${open} open.`;
}

function closedPhasesLine(phases: readonly TodoPhase[]): string | undefined {
	const closedPhases = phases.filter((phase) => phase.items.length > 0 && phase.items.every((item) => isClosed(item.status)));
	if (closedPhases.length === 0) return undefined;
	return `Closed phases: ${closedPhases.map((phase) => `${JSON.stringify(phase.name)} (${phase.items.length}/${phase.items.length})`).join(", ")}`;
}

function defectLines(state: Extract<TodoMoreState, { kind: "list" }>): string[] {
	const lines: string[] = [];
	const unexplained = unexplainedItems(state);
	if (unexplained.length > 0) {
		lines.push(
			`Items without an explanation (${unexplained.length}); batch EXPLAIN commands: ${unexplained.map((item) => JSON.stringify(item.title)).join(", ")}`,
		);
	}
	const unestimated = unestimatedItems(state);
	if (unestimated.length > 0) {
		lines.push(
			`Open items without a time estimate (${unestimated.length}); batch ESTIMATE commands: ${unestimated.map((item) => JSON.stringify(item.title)).join(", ")}`,
		);
	}
	return lines;
}

function indentMultiline(prefix: string, text: string): string {
	const continuation = " ".repeat(prefix.length);
	return `${prefix}${text.replaceAll("\n", `\n${continuation}`)}`;
}

function renderDetailedItem(item: TodoItem, now: number, waits: readonly AskWait[], indent: string): string[] {
	const time = itemTimeSummary(item, now, waits, "full");
	const suffix = time === undefined ? "" : ` (${time})`;
	const lines = [`${indent}- [${item.status}] ${JSON.stringify(item.title)}${suffix}`];
	lines.push(indentMultiline(`${indent}  Explanation: `, explanationText(item)));
	if (item.commit !== undefined) {
		lines.push(`${indent}  Commit: ${commitRecordText(item.commit)} (${commitScopeText(item.commit.scope)})`);
	}
	return lines;
}

export type CompactViewOptions = {
	readonly errors?: readonly string[];
	readonly notes?: readonly string[];
	readonly readOnly?: boolean;
	readonly preamble?: string;
	readonly highlightExplanations?: ReadonlySet<string>;
};

export function formatCompactView(
	state: TodoMoreState,
	now: number,
	waits: readonly AskWait[] = [],
	options: CompactViewOptions = {},
): string {
	const lines: string[] = [currentTimeLine(now)];
	if (options.errors !== undefined && options.errors.length > 0) lines.push(`Errors: ${options.errors.join("; ")}`);
	if (options.preamble !== undefined) lines.push(options.preamble);
	if (state.kind === "empty") {
		if (options.errors === undefined || options.errors.length === 0) {
			lines.push(options.readOnly ? "Todo list is empty." : "Todo list cleared.");
		}
		if (options.notes !== undefined && options.notes.length > 0) lines.push(...options.notes);
		return lines.join("\n");
	}
	const { phases } = state;
	lines.push(...goalSection(state));
	lines.push(overallLine(phases));
	const closedSummary = closedPhasesLine(phases);
	if (closedSummary !== undefined) lines.push(closedSummary);

	const activePhaseIndex = phases.findIndex((phase) => phase.items.some((item) => isOpen(item.status)));
	const workedAhead =
		activePhaseIndex >= 0 && phases.some((phase, index) => index > activePhaseIndex && phase.items.some((item) => isClosed(item.status)));

	let omittedClosed = false;
	let omittedPendingExplanations = false;
	for (const [index, phase] of phases.entries()) {
		const openItems = phase.items.filter((item) => isOpen(item.status));
		const closedCount = phase.items.length - openItems.length;
		if (closedCount > 0) omittedClosed = true;
		if (openItems.length === 0) continue;
		const isActivePhase = index === activePhaseIndex;
		const aheadNote =
			isActivePhase && workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion."
				: "";
		lines.push(
			`${isActivePhase ? "Active phase" : "Phase"} ${index + 1}/${phases.length} ${JSON.stringify(phase.name)} (${closedCount}/${phase.items.length} done)${aheadNote}:`,
		);
		for (const item of openItems) {
			const time = itemTimeSummary(item, now, waits, "inline");
			const flags: string[] = [];
			if (time !== undefined) flags.push(time);
			if (item.status === "pending" && item.explanation.kind === "missing") flags.push("missing explanation");
			const suffix = flags.length > 0 ? ` (${flags.join("; ")})` : "";
			lines.push(`  - [${item.status}] ${JSON.stringify(item.title)}${suffix}`);
			if (item.status === "in_progress" || options.highlightExplanations?.has(item.title)) {
				lines.push(indentMultiline("    Explanation: ", explanationText(item)));
			} else if (item.explanation.kind === "explained") {
				omittedPendingExplanations = true;
			}
		}
	}

	lines.push(...defectLines(state));
	if (options.notes !== undefined && options.notes.length > 0) lines.push(...options.notes);

	const omitted: string[] = [];
	if (omittedClosed) omitted.push("closed items");
	if (omittedPendingExplanations) omitted.push("pending explanations");
	if (omitted.length > 0) {
		lines.push(
			`Omitted: ${omitted.join(" and ")}. Query with VIEW (all open), VIEW ALL (full list), VIEW PHASE "<name>", or VIEW "<title>".`,
		);
	}
	return lines.join("\n");
}

export function formatOpenView(state: TodoMoreState, now: number, waits: readonly AskWait[] = []): string {
	const lines: string[] = [currentTimeLine(now)];
	if (state.kind === "empty") {
		lines.push("Todo list is empty.");
		return lines.join("\n");
	}
	const { phases } = state;
	lines.push(...goalSection(state));
	lines.push(overallLine(phases));
	const closedSummary = closedPhasesLine(phases);
	if (closedSummary !== undefined) lines.push(closedSummary);

	let omittedClosed = false;
	for (const [index, phase] of phases.entries()) {
		const openItems = phase.items.filter((item) => isOpen(item.status));
		const closedCount = phase.items.length - openItems.length;
		if (closedCount > 0) omittedClosed = true;
		if (openItems.length === 0) continue;
		lines.push(`Phase ${index + 1}/${phases.length} ${JSON.stringify(phase.name)} (${closedCount}/${phase.items.length} done):`);
		for (const item of openItems) {
			lines.push(...renderDetailedItem(item, now, waits, "  "));
		}
	}

	lines.push(...defectLines(state));
	if (omittedClosed) {
		lines.push(
			'Closed items omitted. Use VIEW ALL, VIEW PHASE "<name>", or VIEW "<title>" to inspect completed/abandoned items and commits.',
		);
	}
	return lines.join("\n");
}

export function formatFullView(
	state: TodoMoreState,
	now: number,
	waits: readonly AskWait[] = [],
	options: { readonly preamble?: string } = {},
): string {
	const lines: string[] = [currentTimeLine(now)];
	if (options.preamble !== undefined) lines.push(options.preamble);
	if (state.kind === "empty") {
		lines.push("Todo list is empty.");
		return lines.join("\n");
	}
	const { phases } = state;
	lines.push(...goalSection(state));
	lines.push(overallLine(phases));
	for (const [index, phase] of phases.entries()) {
		const closedCount = phase.items.filter((item) => isClosed(item.status)).length;
		lines.push(`Phase ${index + 1}/${phases.length} ${JSON.stringify(phase.name)} (${closedCount}/${phase.items.length} done):`);
		for (const item of phase.items) {
			lines.push(...renderDetailedItem(item, now, waits, "  "));
		}
	}
	lines.push(...defectLines(state));
	return lines.join("\n");
}

export function formatPhaseView(phase: TodoPhase, now: number, waits: readonly AskWait[] = []): string {
	const closedCount = phase.items.filter((item) => isClosed(item.status)).length;
	const openCount = phase.items.length - closedCount;
	const lines: string[] = [
		currentTimeLine(now),
		`Phase ${JSON.stringify(phase.name)} (${closedCount}/${phase.items.length} done, ${openCount} open):`,
	];
	for (const item of phase.items) {
		lines.push(...renderDetailedItem(item, now, waits, "  "));
	}
	return lines.join("\n");
}

export function formatItemView(phaseName: string, item: TodoItem, now: number, waits: readonly AskWait[] = []): string {
	const time = itemTimeSummary(item, now, waits, "full") ?? "none";
	const lines: string[] = [
		currentTimeLine(now),
		`Phase: ${phaseName}`,
		`Title: ${item.title}`,
		`Status: ${item.status}`,
		`Time: ${time}`,
		indentMultiline("Explanation: ", explanationText(item)),
	];
	if (item.commit !== undefined) {
		lines.push(`Commit: ${commitRecordText(item.commit)} (${commitScopeText(item.commit.scope)})`);
	}
	return lines.join("\n");
}
