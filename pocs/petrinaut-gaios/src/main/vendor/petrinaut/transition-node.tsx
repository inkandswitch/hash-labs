import { annotations } from "@inkandswitch/annotations-context";
import { Diff } from "@inkandswitch/annotations-diff";
import { ref, type Ref } from "@inkandswitch/patchwork-refs";
import { useSubscribe } from "@inkandswitch/subscribables-react";
import { IconButton, IconDiagramRegular } from "@hashintel/design-system";
import { Box, Tooltip, Typography } from "@mui/material";
import { useMemo } from "react";
import { Handle, type NodeProps, Position } from "reactflow";

import { useEditorContext } from "./editor-context";
import { handleStyling, transitionStyling } from "./styling";
import type { TransitionNodeData } from "./types";

export const TransitionNode = ({ data, id, isConnectable }: NodeProps<TransitionNodeData>) => {
  const { label, description, childNet } = data;

  const { docHandle, loadPetriNet } = useEditorContext();

  // Create a ref to this node for annotation lookup
  const nodeRef = useMemo(() => {
    if (!docHandle) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ref(docHandle as any, "petriNetDefinition", "nodes", { id }) as Ref;
  }, [docHandle, id]);

  // Query diff annotations reactively
  const nodeAnnotations = useSubscribe(nodeRef ? annotations.onRef(nodeRef) : undefined);
  const diffType = nodeAnnotations?.lookup(Diff)?.type;

  // Diff styling - green for added, amber for changed
  const diffBorderColor = diffType === "added" ? "#22c55e" : diffType === "changed" ? "#f59e0b" : undefined;

  return (
    <div
      style={{
        position: "relative",
        background: "transparent",
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} style={handleStyling} />
      <Box
        sx={(theme) => ({
          ...transitionStyling(theme),
          ...(diffBorderColor && {
            border: `3px solid ${diffBorderColor}`,
            boxShadow: `0 0 8px ${diffBorderColor}40`,
          }),
        })}
      >
        {childNet && (
          <Tooltip title={`Switch to child net ${childNet.childNetTitle}`}>
            <IconButton
              onClick={(event) => {
                event.stopPropagation();

                loadPetriNet(childNet.childNetId);
              }}
              sx={{
                position: "absolute",
                top: 0,
                left: 0,
                "&:hover": {
                  background: "transparent",
                  "& svg": {
                    fill: ({ palette }) => palette.blue[70],
                  },
                },
              }}
            >
              <IconDiagramRegular sx={{ fontSize: 12 }} />
            </IconButton>
          </Tooltip>
        )}

        {label}

        {description && (
          <Typography
            sx={{
              fontSize: "0.75rem",
              color: "text.secondary",
              mt: 0.5,
              textAlign: "center",
            }}
          >
            {description}
          </Typography>
        )}
      </Box>
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} style={handleStyling} />
    </div>
  );
};
