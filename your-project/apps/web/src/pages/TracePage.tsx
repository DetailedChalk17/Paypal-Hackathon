import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, type Trace } from "../api/client";
import { useAuth } from "../auth";
import "@xyflow/react/dist/style.css";

type TraceNodeData = {
  label: string;
  type: string;
  status?: string;
  amountCents?: number;
};

function money(cents = 0) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(cents / 100);
}

function nodePosition(type: string, index: number) {
  const columns: Record<string, number> = {
    donor: 0,
    donation: 250,
    campaign: 500,
    organization: 750,
    milestone: 1000,
    evidence: 1250,
    payout: 1500,
    ledger: 1500,
    ledger_event: 1500,
  };
  return { x: columns[type.toLowerCase()] ?? 500, y: 80 + (index % 4) * 145 };
}

function makeGraph(trace: Trace): { nodes: Node<TraceNodeData>[]; edges: Edge[] } {
  const nodes = trace.nodes.map((item, index) => ({
    id: item.id,
    position: nodePosition(item.type, index),
    data: {
      label: item.label || item.type,
      type: item.type,
      status: typeof item.status === "string" ? item.status : undefined,
      amountCents: typeof item.amountCents === "number"
        ? item.amountCents
        : typeof item.allocatedAmountCents === "number"
          ? item.allocatedAmountCents
          : undefined,
    },
    className: `trace-node trace-node--${item.type.toLowerCase()} trace-node--${String(item.status ?? "default").toLowerCase()}`,
  }));
  const edges = trace.links
    .filter((link) => trace.nodes.some((node) => node.id === link.source) && trace.nodes.some((node) => node.id === link.target))
    .map((link) => ({
      id: link.id,
      source: link.source,
      target: link.target,
      label: typeof link.amountCents === "number" ? money(link.amountCents) : link.label,
      animated: false,
      style: { stroke: "#9bae85", strokeWidth: 2 },
      labelStyle: { fill: "#627558", fontSize: 10, fontWeight: 600 },
    }));
  return { nodes, edges };
}

export function TracePage() {
  const { donationId = "" } = useParams();
  const { user, openSignIn } = useAuth();
  const [selectedId, setSelectedId] = useState("");
  const traceQuery = useQuery({ queryKey: ["trace", donationId], queryFn: () => api.getTrace(donationId), enabled: Boolean(donationId) });
  const graph = useMemo(() => traceQuery.data ? makeGraph(traceQuery.data) : { nodes: [], edges: [] }, [traceQuery.data]);
  const selectedNode = traceQuery.data?.nodes.find((item) => item.id === selectedId);

  if (!user) return <div className="empty-state access-state"><span className="empty-icon">♧</span><h3>Sign in to follow your donation.</h3><p>The trace is only available to people connected with the donation.</p><button className="button button--dark" onClick={() => openSignIn("donor")}>Sign in as supporter</button></div>;
  if (traceQuery.isPending) return <div className="page-loading"><span className="loading-spinner" /> Following your donation…</div>;
  if (traceQuery.isError || !traceQuery.data) {
    return <div className="empty-state access-state"><h3>Trace unavailable</h3><p>{traceQuery.error?.message ?? "We couldn’t find this donation."}</p><Link className="button button--dark" to="/">Back to marketplace</Link></div>;
  }

  return (
    <div className="trace-page">
      <div className="page-back"><Link to={`/receipt/${donationId}`}>← Back to Impact Receipt</Link><span>TRACE MY IMPACT</span></div>
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> FROM GIVER TO GOOD WORK</div><h1>Follow the whole story.</h1><p>Explore how this donation connects to a campaign, its milestones, evidence, and ledger events.</p></div><span className="trace-id">Donation · {donationId.slice(0, 8)}</span></section>
      <div className="trace-legend"><span><i className="legend-dot legend-dot--green" /> Completed</span><span><i className="legend-dot legend-dot--gold" /> In progress</span><span><i className="legend-dot legend-dot--gray" /> Pending</span><span>Click a node to inspect it</span></div>
      <section className="trace-canvas" aria-label="Donation flow graph">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          onNodeClick={(_event, node) => setSelectedId(node.id)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
        >
          <Background color="#e5e9df" gap={22} />
          <Controls />
          <MiniMap nodeColor={(node) => node.className?.includes("paid") || node.className?.includes("completed") ? "#7f9c63" : "#c0ad70"} />
        </ReactFlow>
      </section>
      {selectedNode && (
        <section className="trace-inspector">
          <button className="modal-close" aria-label="Close node details" onClick={() => setSelectedId("")}>×</button>
          <div className="eyebrow"><span className="eyebrow-line" /> {selectedNode.type.toUpperCase()}</div>
          <h2>{selectedNode.label}</h2>
          <p>Status: <strong>{selectedNode.status ?? "recorded"}</strong>{typeof selectedNode.amountCents === "number" ? ` · ${money(selectedNode.amountCents)}` : ""}</p>
          {selectedNode.type.toLowerCase() === "evidence" && typeof selectedNode.id === "string" && <Link to="/reviewer">Open evidence review →</Link>}
          {selectedNode.type.toLowerCase() === "ledger" && <Link to={`/receipt/${donationId}`}>View ledger verification →</Link>}
        </section>
      )}
      <div className="trace-bottom-note"><span>♧</span> Milestone allocations are estimated proportionally and are not PayPal fund segregation.</div>
    </div>
  );
}
