import "./diff-tool.css";
import type { DocHandle, UrlHeads } from "@automerge/automerge-repo";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { useSubscribe } from "@inkandswitch/patchwork-providers-react";
import { createElement, useId, useMemo, useState } from "react";
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
 * property that changed since the draft's baseline. Hovering a row glows the
 * corresponding element on the embedded canvas.
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

	return (
		<div className="petrinaut-diff" key={handle.url}>
			<div className="petrinaut-diff__editor" data-diff-scope={scope}>
				<patchwork-view doc-url={handle.url} tool-id="petrinaut" />
				{hoverId && <style>{hoverGlowRule(scope, hoverId)}</style>}
			</div>
			<div className="petrinaut-diff__panel">
				<ChangePanel
					diff={diff}
					hasBaseline={!!baseline?.heads}
					onHover={setHoverId}
				/>
			</div>
		</div>
	);
}

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

function ChangePanel(props: {
	diff: DocDiff | null;
	hasBaseline: boolean;
	onHover: (id: string | null) => void;
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
							onHover={props.onHover}
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
	onHover: (id: string | null) => void;
}) {
	const { change } = props;
	const hoverable = change.canvasId !== null;
	return (
		<div
			className={`petrinaut-diff__row${hoverable ? " is-hoverable" : ""}`}
			onMouseEnter={() => hoverable && props.onHover(change.canvasId)}
			onMouseLeave={() => hoverable && props.onHover(null)}
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
	return (
		<span className="petrinaut-diff__scalar">
			<span className="petrinaut-diff__label">{field.label}</span>{" "}
			<del>{field.before}</del> <span aria-hidden>→</span>{" "}
			<ins>{field.after}</ins>
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
