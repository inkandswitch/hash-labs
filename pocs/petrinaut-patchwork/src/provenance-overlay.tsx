import type { DocHandle } from "@automerge/automerge-repo";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Doc } from "./datatype";
import { useDocVersion } from "./diff-overlay";
import {
	buildElementRefIndex,
	type ElementRefIndex,
	type FocusDoc,
	focusedElementIds,
	sourcesForElements,
	watchFocusDoc,
	writeHighlight,
} from "./provenance-lib";

/**
 * Two-way provenance highlighting between the net and its source documents,
 * riding Patchwork's shared `patchwork:focus` doc:
 *
 * - INBOUND: when the focus selection/highlight contains refs to this net's
 *   elements (e.g. the text editor pushed the targets of a provenance range
 *   the cursor sits on), the matching places and transitions glow. Petrinaut
 *   has no highlight API, so — like the diff overlay — this is a scoped
 *   stylesheet keyed on the ids React Flow stamps onto its nodes.
 *
 * - OUTBOUND: when the user selects nodes on the canvas (React Flow marks
 *   them `.selected`), the sources of every provenance entry targeting
 *   those elements are pushed into the focus doc's `highlight` map — the
 *   "auxiliary emphasis" bucket any view may contribute to — so the text
 *   editor emphasises and scrolls to the passages the selection came from.
 *   `selection` stays untouched; it belongs to the active cursor producer,
 *   and writing it from here would feed back into the editors.
 */
export function ProvenanceOverlay(props: {
	handle: DocHandle<Doc>;
	element: HTMLElement;
}) {
	const [focusDoc, focusHandle] = useFocusDoc(props.element);
	const scope = useProvenanceScope(props.element);
	const version = useDocVersion(props.handle);

	// Ref url <-> element id, for the net's current places and transitions.
	// Rebuilt when the doc changes (elements come and go).
	const refIndex = useMemo(
		() => buildElementRefIndex(props.handle),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- version forces the rebuild
		[props.handle, version],
	);

	useReportCanvasSelection(props.element, props.handle, focusHandle, refIndex);

	const glowIds = useMemo(
		() => focusedElementIds(focusDoc, refIndex),
		[focusDoc, refIndex],
	);

	if (glowIds.size === 0) {
		return null;
	}
	return <style>{glowRules(scope, glowIds)}</style>;
}

/** React wrapper over the shared focus-doc watcher. */
function useFocusDoc(
	element: HTMLElement,
): [FocusDoc | undefined, DocHandle<FocusDoc> | undefined] {
	const [state, setState] = useState<{
		doc?: FocusDoc;
		handle?: DocHandle<FocusDoc>;
	}>({});

	useEffect(
		() => watchFocusDoc(element, (doc, handle) => setState({ doc, handle })),
		[element],
	);

	return [state.doc, state.handle];
}

/**
 * Watches the canvas for selection changes and mirrors the provenance
 * SOURCES of the selected elements into the focus doc's `highlight` map,
 * removing this view's previous contribution first. React Flow exposes no
 * selection callback through Petrinaut, but it marks selected nodes with a
 * `.selected` class — the same DOM coupling the diff overlay already relies
 * on for `data-id`.
 */
function useReportCanvasSelection(
	element: HTMLElement,
	handle: DocHandle<Doc>,
	focusHandle: DocHandle<FocusDoc> | undefined,
	refIndex: ElementRefIndex,
) {
	// The index changes with every doc edit; keeping it in a ref lets the
	// observer effect survive edits without tearing down and re-contributing.
	const index = useRef(refIndex);
	index.current = refIndex;

	const contributed = useRef<Set<string>>(new Set());
	const lastSelectionKey = useRef("");

	useEffect(() => {
		if (!focusHandle) return;

		let scheduled = false;
		const report = () => {
			scheduled = false;
			const ids = selectedElementIds(element);
			const key = [...ids].sort().join("|");
			if (key === lastSelectionKey.current) return;
			lastSelectionKey.current = key;
			const sources = sourcesForElements(handle, ids, index.current);
			writeHighlight(focusHandle, contributed.current, sources);
			contributed.current = sources;
		};
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(report);
		};

		// Class churn is bounded to React Flow nodes/edges; everything else
		// (including simulation-frame updates) bails out per mutation record.
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.type === "childList") {
					schedule();
					return;
				}
				const target = mutation.target as Element;
				if (
					target.classList?.contains("react-flow__node") ||
					target.classList?.contains("react-flow__edge")
				) {
					schedule();
					return;
				}
			}
		});
		observer.observe(element, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		schedule();

		return () => {
			observer.disconnect();
			writeHighlight(focusHandle, contributed.current, new Set());
			contributed.current = new Set();
			lastSelectionKey.current = "";
		};
	}, [element, handle, focusHandle]);
}

/** data-ids of the currently selected React Flow nodes on this canvas. */
function selectedElementIds(element: HTMLElement): Set<string> {
	const ids = new Set<string>();
	for (const node of element.querySelectorAll<HTMLElement>(
		".react-flow__node.selected",
	)) {
		const id = node.dataset.id;
		if (id) ids.add(id);
	}
	return ids;
}

/** Tag the host element so the generated rules only reach this canvas
 * (mirrors the diff overlay's scoping — two views of one net must not light
 * each other up). */
function useProvenanceScope(element: HTMLElement): string {
	const scope = useId();
	useEffect(() => {
		element.setAttribute(SCOPE_ATTRIBUTE, scope);
		return () => element.removeAttribute(SCOPE_ATTRIBUTE);
	}, [element, scope]);
	return scope;
}

const SCOPE_ATTRIBUTE = "data-petrinaut-provenance";

/** Glow the focused elements in the link accent (the provenance colour the
 * text side uses too), tracking the theme via the studio variable. */
function glowRules(scope: string, ids: Set<string>): string {
	const scoped = `[${SCOPE_ATTRIBUTE}="${cssString(scope)}"]`;
	const rules: string[] = [];
	for (const id of ids) {
		const target = `[data-id="${cssString(id)}"]`;
		rules.push(
			`${scoped} .react-flow__node${target},`,
			`${scoped} .react-flow__edge${target} { filter: ${GLOW}; }`,
		);
	}
	return rules.join("\n");
}

const GLOW =
	"drop-shadow(0 0 6px var(--studio-link, #3b82f6)) drop-shadow(0 0 3px var(--studio-link, #3b82f6))";

const cssString = (value: string) => value.replace(/["\\]/g, "\\$&");
