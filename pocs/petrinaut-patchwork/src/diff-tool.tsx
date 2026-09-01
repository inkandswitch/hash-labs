import "./diff-tool.css";
import type { DocHandle, UrlHeads } from "@automerge/automerge-repo";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { useSubscribe } from "@inkandswitch/patchwork-providers-react";
import {
	createElement,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { Doc } from "./datatype";
import {
	detailedDocDiff,
	diffLines,
	hasDetailedDiff,
	type ChangeKind,
	type DocDiff,
	type EntityChange,
	type FieldChange,
} from "./diff-detail";
import { useDocVersion } from "./diff-overlay";

// `<patchwork-view>` is a custom element the Patchwork host registers; declare
// it for JSX the same way `@inkandswitch/patchwork-elements` does.
declare module "react" {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace JSX {
		interface IntrinsicElements {
			"patchwork-view": React.DetailedHTMLProps<
				React.HTMLAttributes<HTMLElement>,
				HTMLElement
			> & {
				"doc-url"?: string;
				"tool-id"?: string;
			};
		}
	}
}

/**
 * A two-pane diff view: the real Petrinaut editor transcluded on the left
 * (via `<patchwork-view tool-id="petrinaut">`, so the canvas overlays — glow,
 * ghosts — come along for free), and on the right a detailed list of every
 * property that changed since the draft's baseline.
 *
 * The two panes are linked both ways. Hovering a row glows the corresponding
 * element on the embedded canvas; clicking a row opens it in the editor —
 * canvas elements via a synthetic click on the React Flow node or edge they
 * render as, sidebar entities (parameters, token types, equations) by
 * clicking the sidebar entry whose label matches, since Petrinaut exposes no
 * selection API and stamps no ids onto its sidebar. And selecting elements on
 * the canvas highlights their rows in the list (the same `.selected`-class
 * coupling the provenance overlay uses).
 */
export const renderPetrinautDiff: ToolImplementation<Doc> = (
	handle,
	element,
) => {
	const root = createRoot(element);
	root.render(createElement(PetrinautDiff, { handle, element }));
	return () => {
		root.unmount();
	};
};

function PetrinautDiff({
	handle,
	element,
}: {
	handle: DocHandle<Doc>;
	element: HTMLElement;
}) {
	const baseline = useSubscribe<Baseline>(
		element,
		{ type: "draft:baseline", url: handle.url },
		{ heads: null },
	);
	const version = useDocVersion(handle);

	const diff = useMemo(() => {
		const heads = baseline?.heads;
		if (!heads) return null;
		const doc = handle.doc();
		if (!doc) return null;
		return detailedDocDiff(doc, heads);
		// `version` forces the recompute when the doc changes.
	}, [handle, baseline?.heads, version]);

	const [hoverId, setHoverId] = useState<string | null>(null);
	const scope = useId();

	const [editor, setEditor] = useState<HTMLDivElement | null>(null);
	const selectedIds = useSelectedCanvasIds(editor);

	const activate = useCallback(
		(change: EntityChange, section: string) => {
			if (!editor) return;
			if (change.canvasId) {
				clickCanvasElement(editor, change.canvasId);
			} else if (SIDEBAR_SECTIONS.has(section)) {
				clickSidebarEntry(editor, change.name);
			}
		},
		[editor],
	);

	return (
		<div className="petrinaut-diff" key={handle.url}>
			<div
				className="petrinaut-diff__editor"
				data-diff-scope={scope}
				ref={setEditor}
			>
				<patchwork-view doc-url={handle.url} tool-id="petrinaut" />
				{hoverId && <style>{hoverGlowRule(scope, hoverId)}</style>}
			</div>
			<div className="petrinaut-diff__panel">
				<ChangePanel
					diff={diff}
					hasBaseline={!!baseline?.heads}
					selectedIds={selectedIds}
					onHover={setHoverId}
					onActivate={activate}
				/>
			</div>
		</div>
	);
}

/** Sections whose entities live in Petrinaut's sidebar rather than on the
 * canvas — clickable through the text-matching fallback. */
const SIDEBAR_SECTIONS = new Set([
	"Parameters",
	"Token types",
	"Differential equations",
]);

/** Diff baseline (fork-point heads) served by Patchwork's draft overlay;
 * `heads` is `null` rather than absent so the value stays structured-cloneable
 * crossing the provider channel (same shape as the canvas overlay uses). */
type Baseline = { heads: UrlHeads | null };

/** Glow one canvas element inside this tool's transcluded editor only. */
function hoverGlowRule(scope: string, id: string): string {
	const scoped = `[data-diff-scope="${cssString(scope)}"]`;
	const target = `[data-id="${cssString(id)}"]`;
	return (
		`${scoped} .react-flow__node${target},` +
		`${scoped} .react-flow__edge${target} { filter: ${HOVER_GLOW}; }`
	);
}

const HOVER_GLOW =
	"drop-shadow(0 0 8px #3b82f6) drop-shadow(0 0 4px #3b82f6)";

const cssString = (value: string) => value.replace(/["\\]/g, "\\$&");

/** Select a place, transition or arc in the embedded editor by synthesising
 * a click on the React Flow node or edge it renders as. Petrinaut opens the
 * properties panel for whatever the canvas selects. */
function clickCanvasElement(editor: HTMLElement, id: string) {
	const target = editor.querySelector<HTMLElement>(
		`.react-flow__node[data-id="${CSS.escape(id)}"],` +
			`.react-flow__edge[data-id="${CSS.escape(id)}"]`,
	);
	if (target) synthesizeClick(target);
}

/** Open a sidebar entity (parameter, token type, equation) by clicking the
 * sidebar entry whose visible label matches its name. Best-effort: Petrinaut
 * stamps no ids onto sidebar rows, so this goes by text and silently does
 * nothing when the name isn't found (e.g. the sidebar is collapsed). */
function clickSidebarEntry(editor: HTMLElement, name: string) {
	const canvas = editor.querySelector(".react-flow");
	const label = name.trim();
	if (!label) return;

	// The innermost element whose text is exactly the name, outside the canvas.
	let match: HTMLElement | null = null;
	for (const candidate of editor.querySelectorAll<HTMLElement>("*")) {
		if (canvas?.contains(candidate)) continue;
		if (candidate.textContent?.trim() !== label) continue;
		if (!match || match.contains(candidate)) match = candidate;
	}
	if (!match) return;

	const clickable =
		match.closest<HTMLElement>("button, [role='button'], a, li") ?? match;
	synthesizeClick(clickable);
}

/** A full pointer gesture, since React Flow reacts to pointer events and
 * plain buttons to `click`. */
function synthesizeClick(target: HTMLElement) {
	const rect = target.getBoundingClientRect();
	const at = {
		bubbles: true,
		cancelable: true,
		button: 0,
		clientX: rect.x + rect.width / 2,
		clientY: rect.y + rect.height / 2,
	};
	const pointer = { ...at, pointerId: 1, isPrimary: true };
	target.dispatchEvent(new PointerEvent("pointerdown", pointer));
	target.dispatchEvent(new MouseEvent("mousedown", at));
	target.dispatchEvent(new PointerEvent("pointerup", pointer));
	target.dispatchEvent(new MouseEvent("mouseup", at));
	target.dispatchEvent(new MouseEvent("click", at));
}

/** The data-ids of the canvas elements currently selected in the embedded
 * editor, so the panel can highlight their rows. React Flow exposes no
 * selection callback through Petrinaut, but it marks selected nodes and
 * edges with a `.selected` class — the same DOM coupling the provenance
 * overlay relies on. */
function useSelectedCanvasIds(editor: HTMLElement | null): Set<string> {
	const [ids, setIds] = useState<Set<string>>(() => new Set());

	useEffect(() => {
		if (!editor) return;

		let scheduled = false;
		const read = () => {
			scheduled = false;
			const next = new Set<string>();
			for (const node of editor.querySelectorAll<HTMLElement>(
				".react-flow__node.selected, .react-flow__edge.selected",
			)) {
				if (node.dataset.id) next.add(node.dataset.id);
			}
			setIds((previous) => (isSameSet(previous, next) ? previous : next));
		};
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(read);
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
		observer.observe(editor, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		schedule();

		return () => observer.disconnect();
	}, [editor]);

	return ids;
}

const isSameSet = (a: Set<string>, b: Set<string>) =>
	a.size === b.size && [...a].every((value) => b.has(value));

function ChangePanel(props: {
	diff: DocDiff | null;
	hasBaseline: boolean;
	selectedIds: Set<string>;
	onHover: (id: string | null) => void;
	onActivate: (change: EntityChange, section: string) => void;
}) {
	if (!props.hasBaseline) {
		return (
			<EmptyState
				title="No changes"
				detail="No baseline is selected — check out a draft to compare against its fork point."
			/>
		);
	}
	if (!hasDetailedDiff(props.diff)) {
		return (
			<EmptyState
				title="No changes"
				detail="This draft hasn't changed anything yet."
			/>
		);
	}
	return (
		<>
			<header className="petrinaut-diff__header">Changes</header>
			{props.diff.sections.map((section) => (
				<section key={section.title} className="petrinaut-diff__section">
					<h3>{section.title}</h3>
					{section.changes.map((change) => (
						<ChangeRow
							key={change.id}
							change={change}
							section={section.title}
							selected={
								change.canvasId !== null &&
								props.selectedIds.has(change.canvasId)
							}
							onHover={props.onHover}
							onActivate={props.onActivate}
						/>
					))}
				</section>
			))}
		</>
	);
}

function EmptyState(props: { title: string; detail: string }) {
	return (
		<div className="petrinaut-diff__empty">
			<strong>{props.title}</strong>
			<p>{props.detail}</p>
		</div>
	);
}

function ChangeRow(props: {
	change: EntityChange;
	section: string;
	selected: boolean;
	onHover: (id: string | null) => void;
	onActivate: (change: EntityChange, section: string) => void;
}) {
	const { change } = props;
	const hoverable = change.canvasId !== null;
	// Removed entities aren't in the live editor, so there is nothing to open.
	const clickable =
		change.kind !== "removed" &&
		(change.canvasId !== null || SIDEBAR_SECTIONS.has(props.section));

	// Keep the row in sight when its element gets selected on the canvas.
	const row = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (props.selected) {
			row.current?.scrollIntoView({ block: "nearest" });
		}
	}, [props.selected]);

	const classes = [
		"petrinaut-diff__row",
		hoverable && "is-hoverable",
		clickable && "is-clickable",
		props.selected && "is-selected",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<div
			ref={row}
			className={classes}
			onMouseEnter={() => hoverable && props.onHover(change.canvasId)}
			onMouseLeave={() => hoverable && props.onHover(null)}
			onClick={(event) => {
				// Toggling a code-diff <details> is not a navigation.
				if ((event.target as HTMLElement).closest("details")) return;
				if (clickable) props.onActivate(change, props.section);
			}}
		>
			<div className="petrinaut-diff__row-head">
				<span className={`petrinaut-diff__badge is-${change.kind}`}>
					{BADGE[change.kind]}
				</span>
				<span className="petrinaut-diff__name">{change.name}</span>
				{change.moved && (
					<span className="petrinaut-diff__moved">moved</span>
				)}
			</div>
			{change.fields.length > 0 && (
				<ul className="petrinaut-diff__fields">
					{change.fields.map((field, index) => (
						<li key={index}>
							{field.code ? (
								<CodeChange field={field} />
							) : (
								<ScalarChange field={field} />
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

const BADGE: Record<ChangeKind, string> = {
	added: "+",
	removed: "−",
	edited: "~",
	moved: "⇢",
};

function ScalarChange({ field }: { field: FieldChange }) {
	// One-sided fields (added/removed entities describing their values) skip
	// the arrow and show just the side that exists.
	return (
		<span className="petrinaut-diff__scalar">
			<span className="petrinaut-diff__label">{field.label}</span>{" "}
			{field.before !== "" && <del>{field.before}</del>}
			{field.before !== "" && field.after !== "" && (
				<>
					{" "}
					<span aria-hidden>→</span>{" "}
				</>
			)}
			{field.after !== "" && <ins>{field.after}</ins>}
		</span>
	);
}

function CodeChange({ field }: { field: FieldChange }) {
	const lines = useMemo(
		() => diffLines(field.before, field.after),
		[field.before, field.after],
	);
	const added = lines.filter((line) => line.type === "added").length;
	const removed = lines.filter((line) => line.type === "removed").length;

	return (
		<details className="petrinaut-diff__code">
			<summary>
				<span className="petrinaut-diff__label">{field.label}</span>{" "}
				<span className="petrinaut-diff__counts">
					{added > 0 && <ins>+{added}</ins>}
					{removed > 0 && <del>−{removed}</del>}
				</span>
			</summary>
			<pre>
				{lines.map((line, index) => (
					<div key={index} className={`is-${line.type}`}>
						<span className="petrinaut-diff__gutter">
							{line.type === "added"
								? "+"
								: line.type === "removed"
									? "-"
									: " "}
						</span>
						{line.text || " "}
					</div>
				))}
			</pre>
		</details>
	);
}
