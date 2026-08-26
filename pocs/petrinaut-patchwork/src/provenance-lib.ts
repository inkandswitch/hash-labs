import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import { subscribe } from "@inkandswitch/patchwork-providers";
import type { Doc } from "./datatype";

/**
 * The Patchwork sections of a Petri net document, shared by the canvas
 * overlay, the map tool and the skill API. Everything Patchwork-side lives
 * under the `@patchwork` envelope next to the datatype tag — provenance
 * entries and per-element metadata — so tools invent no further top-level
 * sections. `petriNetDefinition` stays exactly what Petrinaut validates.
 */
export type PatchworkSection = {
	type: string;
	/** Where parts of this net came from (see ProvenanceEntry). */
	provenance?: ProvenanceEntry[];
	/** Arbitrary per-element annotations, keyed by element id. */
	metadata?: Record<string, ElementMetadata>;
};

/** Open-ended; `geo` is the one convention tools understand (the map). */
export type ElementMetadata = {
	geo?: { lat: number; lng: number };
	[key: string]: unknown;
};

export type ProvenanceEntry = {
	id: string;
	/** What in this doc was generated — always automerge urls. */
	targets: AutomergeUrl[];
	/** Where it came from — always automerge urls, usually cursor-anchored. */
	sources: AutomergeUrl[];
	createdAt?: number;
	note?: string;
};

export type NetDoc = Doc & { "@patchwork"?: PatchworkSection };

/** The shared focus doc (see Patchwork's FocusProvider). */
export type FocusDoc = {
	selection: Record<string, true>;
	highlight: Record<string, true>;
};

export type ElementRefIndex = {
	idByRefUrl: Map<string, string>;
	refUrlById: Map<string, string>;
};

/**
 * Live view of the shared focus doc. The focus provider emits the doc's url;
 * the handle is then resolved through the repo Patchwork puts on the tool's
 * host element. Calls `onUpdate` with the current doc on every change.
 * Returns a cleanup function.
 */
export function watchFocusDoc(
	element: HTMLElement,
	onUpdate: (doc: FocusDoc | undefined, handle: DocHandle<FocusDoc>) => void,
): () => void {
	const repo = (element as HTMLElement & { repo?: Repo }).repo;
	let disposed = false;
	let detach: (() => void) | undefined;

	const unsubscribe = subscribe(
		element,
		{ type: "patchwork:focus" },
		(url) => {
			if (disposed || !repo || typeof url !== "string") return;
			detach?.();
			detach = undefined;
			Promise.resolve(repo.find<FocusDoc>(url as AutomergeUrl)).then(
				(handle) => {
					if (disposed) return;
					const emit = () => onUpdate(handle.doc(), handle);
					handle.on("change", emit);
					detach = () => handle.off("change", emit);
					emit();
				},
			);
		},
	);

	return () => {
		disposed = true;
		detach?.();
		unsubscribe();
	};
}

/**
 * Mint the ref url of every place and transition, both directions. The urls
 * match what the skill / make_ref mint for provenance targets (same doc,
 * same `{id}` matcher path), so lookups are plain string equality.
 */
export function buildElementRefIndex(handle: DocHandle<Doc>): ElementRefIndex {
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
export function elementRefUrl(
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

/** Sources of every provenance entry that targets one of the elements. */
export function sourcesForElements(
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
		(handle.doc() as NetDoc | undefined)?.["@patchwork"]?.provenance ?? [];
	for (const entry of entries) {
		if (!entry.targets?.some((target) => selectedRefUrls.has(target))) {
			continue;
		}
		for (const source of entry.sources ?? []) sources.add(source);
	}
	return sources;
}

/** Replace one view's previous contribution to `highlight` with `next`. */
export function writeHighlight(
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

export const setsEqual = (a: Set<string>, b: Set<string>) =>
	a.size === b.size && [...a].every((value) => b.has(value));

/** Element ids the focus doc points at, via the ref index. */
export function focusedElementIds(
	focusDoc: FocusDoc | undefined,
	index: ElementRefIndex,
): Set<string> {
	const ids = new Set<string>();
	for (const url of [
		...Object.keys(focusDoc?.selection ?? {}),
		...Object.keys(focusDoc?.highlight ?? {}),
	]) {
		const id = index.idByRefUrl.get(url);
		if (id) ids.add(id);
	}
	return ids;
}
