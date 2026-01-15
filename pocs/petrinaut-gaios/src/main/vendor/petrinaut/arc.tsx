import { annotations } from "@inkandswitch/annotations-context";
import { Diff } from "@inkandswitch/annotations-diff";
import { ref, type Ref } from "@inkandswitch/patchwork-refs";
import { useSubscribe } from "@inkandswitch/subscribables-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getBezierPath, type Position } from "reactflow";

import { useEditorContext } from "./editor-context";
import { generateUuid } from "./generate-uuid";
import { useSimulationContext } from "./simulation-context";
import type { TokenType } from "./types";

type AnimatingToken = {
  id: string;
  tokenTypeId: string;
};

export const Arc = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  data?: {
    tokenWeights: {
      [tokenTypeId: string]: number;
    };
  };
}) => {
  const { docHandle, petriNetDefinition } = useEditorContext();

  const { simulationSpeed } = useSimulationContext();

  // Create a ref to this arc for annotation lookup
  const arcRef = useMemo(() => {
    if (!docHandle) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ref(docHandle as any, "petriNetDefinition", "arcs", { id }) as Ref;
  }, [docHandle, id]);

  // Query diff annotations reactively
  const arcAnnotations = useSubscribe(arcRef ? annotations.onRef(arcRef) : undefined);
  const diffType = arcAnnotations?.lookup(Diff)?.type;

  // Diff styling - green for added, amber for changed
  const diffStrokeColor = diffType === "added" ? "#22c55e" : diffType === "changed" ? "#f59e0b" : "#555";

  const [animatingTokens, setAnimatingTokens] = useState<AnimatingToken[]>([]);
  const [arcPath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const addAnimatingToken = useCallback((tokenTypeId: string) => {
    const newToken: AnimatingToken = {
      id: generateUuid(),
      tokenTypeId,
    };

    setAnimatingTokens((current) => [...current, newToken]);
  }, []);

  /**
   * Handle the event fired from SimulationContext to animate a token along the arcs of enabled transitions.
   */
  useEffect(() => {
    const handleTransitionFired = (
      event: CustomEvent<{
        arcId: string;
        tokenTypeId: string;
      }>
    ) => {
      const { arcId, tokenTypeId } = event.detail;
      if (arcId === id) {
        addAnimatingToken(tokenTypeId);
      }
    };

    window.addEventListener("animateTokenAlongArc", handleTransitionFired as EventListener);

    return () => {
      window.removeEventListener("animateTokenAlongArc", handleTransitionFired as EventListener);
    };
  }, [id, addAnimatingToken]);

  return (
    <>
      {/* Glow effect for diff-highlighted arcs */}
      {diffType && (
        <path
          d={arcPath}
          fill="none"
          strokeWidth={8}
          stroke={diffStrokeColor}
          style={{
            pointerEvents: "none",
            opacity: 0.3,
            filter: "blur(2px)",
          }}
        />
      )}
      <path
        id={id}
        className="react-flow__edge-path"
        d={arcPath}
        fill="none"
        strokeWidth={20}
        stroke={diffStrokeColor}
        style={{
          cursor: "pointer",
          strokeOpacity: 0.1,
        }}
      />
      <path id={`${id}-visible`} className="react-flow__edge-path" d={arcPath} fill="none" strokeWidth={diffType ? 3 : 2} stroke={diffStrokeColor} style={{ pointerEvents: "none" }} />
      {animatingTokens.map((token) => {
        const tokenType = petriNetDefinition.tokenTypes.find((tt: TokenType) => tt.id === token.tokenTypeId);
        return (
          <g key={token.id}>
            <circle
              r="6"
              fill={tokenType?.color ?? "#3498db"}
              className="animating-token"
              style={{
                offsetPath: `path("${arcPath}")`,
                offsetDistance: "0%",
              }}
            />
          </g>
        );
      })}
      <style>
        {`
            .gaios-petrinaut .animating-token {
              animation: gaios-petrinaut-moveToken ${simulationSpeed / 2}ms linear forwards;
            }
            @keyframes gaios-petrinaut-moveToken {
              0% {
                offset-distance: 0%;
                opacity: 1;
              }
              90% {
                opacity: 1;
              }
              100% {
                offset-distance: 100%;
                opacity: 0;
              }
            }
          `}
      </style>
      <g transform={`translate(${labelX}, ${labelY})`}>
        {/* Show tokens required or produced */}
        {Object.entries(data?.tokenWeights ?? {})
          .filter(([, weight]) => weight > 0)
          .map(([tokenTypeId, weight], index, nonZeroWeights) => {
            const tokenType = petriNetDefinition.tokenTypes.find((tt: TokenType) => tt.id === tokenTypeId);

            if (!tokenType) {
              return null;
            }

            const yOffset = (index - (nonZeroWeights.length - 1) / 2) * 20;

            return (
              <g key={tokenTypeId} transform={`translate(0, ${yOffset})`}>
                <circle cx="0" cy="0" r="10" fill={tokenType.color} />
                <text
                  x="0"
                  y="0"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    fill: "white",
                    pointerEvents: "none",
                  }}
                >
                  {weight}
                </text>
              </g>
            );
          })}
      </g>
    </>
  );
};
