"use client";
// The live LangGraph — the orchestration made visible. The 8 nodes of the compiled StateGraph in
// order, with control flowing left→right (edges pulse as control passes), the two conditional gates
// dropping below Roles and Verifier and igniting when they fire, and one focus line stating what the
// active agent is doing right now. This region is the "how the back-end works" centerpiece.
import { AGENTS, AGENT_META } from "@/lib/agents";
import type { AgentKey, BranchKey, Caption, Status } from "@/lib/stageTypes";

function nodeState(status: Status, active: boolean): string {
  if (active) return "active";
  if (status === "done") return "done";
  if (status === "waiting") return "waiting";
  return "idle";
}

const BRANCH_AT: Partial<Record<AgentKey, { key: BranchKey; label: string }>> = {
  roles: { key: "roles", label: "roles_review" },
  verifier: { key: "verifier", label: "reconcile" },
};

export function FlowGraph({
  statuses,
  activeAgent,
  captions,
  branch,
}: {
  statuses: Record<AgentKey, Status>;
  activeAgent: AgentKey | null;
  captions: Record<AgentKey, Caption>;
  branch: Record<BranchKey, boolean>;
}) {
  const focusMeta = activeAgent ? AGENT_META[activeAgent] : null;
  const focusCap = activeAgent ? captions[activeAgent] : null;
  const focusStatus = activeAgent ? statuses[activeAgent] : "idle";
  const running = focusStatus === "running" || focusStatus === "streaming";

  return (
    <div className="flow-band">
      <div className="flow-tag">
        <span className="gp">LangGraph</span> · one compiled StateGraph · native interrupt() + 2 confidence-driven gates
      </div>

      <div className="flow">
        {AGENTS.map((a, i) => {
          const active = activeAgent === a.key;
          const state = nodeState(statuses[a.key], active);
          const br = BRANCH_AT[a.key];
          const next = AGENTS[i + 1];
          const edgeDone = statuses[a.key] === "done";
          const edgeFlow = next ? activeAgent === next.key && statuses[next.key] !== "done" : false;
          return (
            <FlowFragment key={a.key}>
              <div className="fnode" data-state={state} data-status={statuses[a.key]} style={{ ["--accent" as string]: a.accent }}>
                <div className="fnode-disc">{statuses[a.key] === "done" && !active ? "✓" : a.num}</div>
                <div className="fnode-label">{a.label}</div>
                {br && (
                  <div className="fbranch" data-ignited={branch[br.key]}>
                    <span className="stem" />
                    <span className="bnode">
                      <span className="bdot" />
                      <span className="lbl">{br.label}</span>
                    </span>
                  </div>
                )}
              </div>
              {next && (
                <div className="fedge" data-done={edgeDone} data-flow={edgeFlow} style={{ ["--accent" as string]: next.accent }}>
                  <span className="arrow">▶</span>
                </div>
              )}
            </FlowFragment>
          );
        })}
      </div>

      <div className="focus-line" style={{ ["--accent" as string]: focusMeta?.accent ?? "#60a5fa" }}>
        {focusMeta ? (
          <>
            <span className="fl-dot" />
            <span className="fl-agent">{focusMeta.label}</span>
            <span className="fl-step">
              {focusCap?.done ? (focusCap.summary ?? "done") : (focusCap?.step ?? focusMeta.step)}
              {running && <span className="caret" />}
            </span>
          </>
        ) : (
          <span className="fl-idle">graph idle — press Start to run the consultation</span>
        )}
      </div>
    </div>
  );
}

// Tiny fragment helper so each node+edge pair keys cleanly.
function FlowFragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
