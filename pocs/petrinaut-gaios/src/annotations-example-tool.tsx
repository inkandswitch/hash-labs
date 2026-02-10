import type { AutomergeUrl } from "@automerge/automerge-repo";
import { useDocHandle } from "@automerge/automerge-repo-react-hooks";
import { annotations as globalAnnotations } from "@inkandswitch/annotations-context";
import { toolify } from "@inkandswitch/patchwork-react";
import { ref } from "@inkandswitch/patchwork-refs";
import { computed } from "@inkandswitch/subscribables";
import { useSubscribe } from "@inkandswitch/subscribables-react";
import { useMemo } from "react";
import { Doc } from "./datatype";

// Inline styling for a nicer table
const tableStyle: React.CSSProperties = {
  borderCollapse: "separate",
  borderSpacing: 0,
  width: "100%",
  marginTop: 12,
  background: "#fff",
  borderRadius: 8,
  boxShadow: "0 1px 5px 0 rgba(50,60,105,0.07)",
  overflow: "hidden",
  fontSize: 15,
};

const thStyle: React.CSSProperties = {
  background: "#f8fafc",
  color: "#555",
  fontWeight: 600,
  padding: "12px 10px",
  textAlign: "left",
  borderBottom: "1.5px solid #e2e8f0",
};

const tdStyle: React.CSSProperties = {
  padding: "10px",
  borderBottom: "1px solid #f1f5f9",
  background: "#fff",
  verticalAlign: "top",
  fontFamily: "Menlo, Monaco, monospace",
  wordBreak: "break-word",
};

const trHoverStyle: React.CSSProperties = {
  backgroundColor: "#f6f9fb",
};

const noAnnotationsStyle: React.CSSProperties = {
  textAlign: "center",
  color: "#888",
  fontStyle: "italic",
  background: "#fafdff",
  padding: "20px 0",
};

export const AnnotationsExampleTool = ({ docUrl }: { docUrl: AutomergeUrl }) => {
  const docHandle = useDocHandle<Doc>(docUrl, { suspense: true });
  const docRef = useMemo(() => ref(docHandle), [docHandle]);

  // Collect and format all annotations
  const allAnnotations = useSubscribe(
    useMemo(
      () =>
        computed(() => {
          return Array.from(globalAnnotations.onPartOf(docRef)).map(([ref, annotation]) => {
            return {
              ref: ref.toString(),
              key: annotation.type.id,
              value: annotation.value,
            };
          });
        }),
      [docRef]
    )
  );

  (window as any).allAnnotations = allAnnotations;

  // Render a table for annotations
  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>All Annotations</h2>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Ref</th>
            <th style={thStyle}>Key</th>
            <th style={thStyle}>Value</th>
          </tr>
        </thead>
        <tbody>
          {allAnnotations && allAnnotations.length > 0 ? (
            allAnnotations.map((ann, idx) => (
              <tr key={idx} style={idx % 2 === 1 ? trHoverStyle : undefined}>
                <td style={tdStyle}>{ann.ref}</td>
                <td style={tdStyle}>{ann.key}</td>
                <td style={tdStyle}>
                  <pre style={{ margin: 0, background: "none", whiteSpace: "pre-wrap", fontSize: 13 }}>{valueToString(ann.value)}</pre>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={3} style={noAnnotationsStyle}>
                No annotations found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

const valueToString = (value: any) => {
  try {
    return JSON.stringify(value, (key, value) => {
      if (typeof value === "object" && "docHandle" in value && value.docHandle instanceof DocHandle && "path" in value.docHandle) {
        return value.toString();
      }

      return value;
    });
  } catch (e) {
    return String(value);
  }
};

export const renderAnnotationsExampleTool = toolify(AnnotationsExampleTool);
