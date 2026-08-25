import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import { useSubscribe } from "@inkandswitch/patchwork-providers-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Doc } from "./datatype";
import { useDocVersion } from "./diff-overlay";

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
 *   them `.selected`), the sources of every `@provenance` entry targeting
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

	const glowIds = useMemo(() => {
		const ids = new Set<string>();
		for (const url of [
			...Object.keys(focusDoc?.selection ?? {}),
			...Object.keys(focusDoc?.highlight ?? {}),
		]) {
			const id = refIndex.idByRefUrl.get(url);
			if (id) ids.add(id);
		}
		return ids;
	}, [focusDoc, refIndex]);

	if (glowIds.size === 0) {
		return null;
	}
	return <style>{glowRules(scope, glowIds)}</style>;
}

/** The shared focus doc (see Patchwork's FocusProvider). */
type FocusDoc = {
	selection: Record<string, true>;
	highlight: Record<string, true>;
};

/**
 * Live view of the shared focus doc. The focus provider emits the doc's url;
 * the handle is then resolved through the repo Patchwork puts on the tool's
 * host element. (providers-react's useSubscribeDoc would do this, but it
 * resolves through React's RepoContext, which this tool doesn't mount.)
 */
function useFocusDoc(
	element: HTMLElement,
): [FocusDoc | undefined, DocHandle<FocusDoc> | undefined] {
	const focusUrl = useSubscribe<AutomergeUrl>(element, {
		type: "patchwork:focus",
	});
	const [state, setState] = useState<{
		doc?: FocusDoc;
		handle?: DocHandle<FocusDoc>;
	}>({});

	useEffect(() => {
		const repo = (element as HTMLElement & { repo?: Repo }).repo;
		if (!focusUrl || !repo) return;
		let disposed = false;
		let unsubscribe: (() => void) | undefined;
		Promise.resolve(repo.find<FocusDoc>(focusUrl)).then((handle) => {
			if (disposed) return;
			const update = () => setState({ doc: handle.doc(), handle });
			handle.on("change", update);
			unsubscribe = () => handle.off("change", update);
			update();
		});
		return () => {
			disposed = true;
			unsubscribe?.();
		};
	}, [element, focusUrl]);

	return [state.doc, state.handle];
}

type DocWithProvenance = Doc & {
	"@provenance"?: { entries: ProvenanceEntry[] };
};

type ProvenanceEntry = {
	id: string;
	targets?: AutomergeUrl[];
	sources?: AutomergeUrl[];
};

type ElementRefIndex = {
	idByRefUrl: Map<string, string>;
	refUrlById: Map<string, string>;
};

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

/** Sources of every `@provenance` entry that targets a selected element. */
function sourcesForElements(
	handle: DocHandle<Doc>,
	ids: Set<string>,
	index: ElementRefIndex,
): Set<string> {
	const sources = new Set<string>();
	if (ids.size === 0) return sources;
	const selectedRefUrls = new Set<string>();
	for (const id of ids) {
		const url = index.refUrlById.get(id);
		if (url) selectedRefUrls.add(url);
	}
	const entries =
		(handle.doc() as DocWithProvenance | undefined)?.["@provenance"]
			?.entries ?? [];
	for (const entry of entries) {
		if (!entry.targets?.some((target) => selectedRefUrls.has(target))) {
			continue;
		}
		for (const source of entry.sources ?? []) sources.add(source);
	}
	return sources;
}

/** Replace this view's previous contribution to `highlight` with `next`. */
function writeHighlight(
	focusHandle: DocHandle<FocusDoc>,
	previous: Set<string>,
	next: Set<string>,
) {
	if (setsEqual(previous, next)) return;
	focusHandle.change((doc) => {
		if (!doc.highlight) doc.highlight = {};
		for (const url of previous) {
			if (!next.has(url)) delete doc.highlight[url];
		}
		for (const url of next) doc.highlight[url] = true;
	});
}

const setsEqual = (a: Set<string>, b: Set<string>) =>
	a.size === b.size && [...a].every((value) => b.has(value));

/**
 * Mint the ref url of every place and transition, both directions. The urls
 * match what the skill / make_ref mint for provenance targets (same doc,
 * same `{id}` matcher path), so lookups are plain string equality.
 */
function buildElementRefIndex(handle: DocHandle<Doc>): ElementRefIndex {
	const idByRefUrl = new Map<string, string>();
	const refUrlById = new Map<string, string>();
	const def = handle.doc()?.petriNetDefinition;
	const add = (arrayName: "places" | "transitions", id: string) => {
		const url = elementRefUrl(handle, arrayName, id);
		if (!url) return;
		idByRefUrl.set(url, id);
		refUrlById.set(id, url);
	};
	for (const place of def?.places ?? []) add("places", place.id);
	for (const transition of def?.transitions ?? []) {
		add("transitions", transition.id);
	}
	return { idByRefUrl, refUrlById };
}

// The runtime exposes handle.sub (subduction) or handle.ref (upstream
// automerge-repo) — same call shape, different name.
function elementRefUrl(
	handle: DocHandle<unknown>,
	arrayName: string,
	id: string,
): string | undefined {
	const h = handle as unknown as {
		sub?: (...segments: unknown[]) => { url: string };
		ref?: (...segments: unknown[]) => { url: string };
	};
	const make = h.sub ?? h.ref;
	if (!make) return undefined;
	try {
		return make.call(handle, "petriNetDefinition", arrayName, { id }).url;
	} catch {
		return undefined;
	}
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
