import { jsonify } from "../../test/utils"
import { IEvent } from "../collector/event"
import { NodeLabel } from "../collector/logger"
import TypedGraph from "../collector/typedgraph"
import { generateColors } from "../color"
import "../object/extensions"
import { IObservableTree, IObserverTree, ObservableTree, ObserverTree } from "../oct/oct"
import "../utils"
import { Graphs, ViewState } from "./index"
import { MarbleCoordinator } from "./marbles"
import MorphModule from "./morph"
import * as Rx from "rx"
import { h } from "snabbdom"
import { VNode } from "snabbdom/vnode"

export type Layout = {
  edges: { points: { x: number, y: number }[], v: string, w: string }[],
  nodes: { id: string, x: number, y: number }[],
}[]

export type In = Rx.Observable<({ _sequence: number, layout: Layout, viewState: ViewState, graphs: Graphs })>
export type Out = { svg: Rx.Observable<VNode>, clicks: Rx.Observable<string[]>, groupClicks: Rx.Observable<string> }
export function graph$(inp: In): Out {
  let result = inp.map(data => {
    return graph(data.layout, data.viewState, data.graphs, data._sequence)
  }).publish().refCount()

  return {
    clicks: result.flatMap(_ => _.clicks),
    groupClicks: result.flatMap(_ => _.groupClicks),
    svg: result.map(_ => _.svg),
  }
}

const u = 100
const mx = u / 2
const my = u

function filterLabels(labels: NodeLabel[], viewState: ViewState): NodeLabel[] {
  if (typeof labels === "undefined" || !labels.length) { return [] }
  return labels
    .filter(l => l.label.type === "observable")
    .filter(l =>
      viewState.openGroups.indexOf(`${l.group}`) === -1 && (
        !l.groups ||
        !l.groups.length ||
        l.groups.slice(-1).some(g => viewState.openGroups.indexOf(`${g}`) >= 0)
      )
    )
}

export function mapTuples<T, R>(list: T[], f: (a: T, b: T, anr: number, bnr: number) => R): R[] {
  let result = []
  for (let i = 1, ref = i - 1; i < list.length; i++ , ref++) {
    result.push(f(list[ref], list[i], ref, i))
  }
  return result
}

function nodeLabel(node: IObservableTree | IObserverTree): string {
  if (node instanceof ObservableTree && node.calls) {
    let call = node.calls[node.calls.length - 1]
    return `${call.method}(${call.args})`
  }
  if (node && node.names) {
    return node.names[node.names.length - 1]
  }
  return ""
}

function getObservable(
  observerNode: string,
  ...lookupGraphs: TypedGraph<IObservableTree | IObserverTree, {}>[]
): IObservableTree | undefined {
  return lookupGraphs.filter(g => g.hasNode(observerNode)).map(g => {
    // shortcut
    if (g.hasNode(observerNode)) {
      return (g.node(observerNode) as IObserverTree).observable
    }
    // long way round
    let inEs = g
      .inEdges(observerNode)
    if (!inEs) {
      console.warn("Observable for Observer(" + observerNode + ") not found")
      return undefined
    }
    let observable = inEs.map(e => g.node(e.v))
      .find(_ => !(_ instanceof ObserverTree))
    return observable as IObservableTree
  }).find(v => typeof v !== "undefined")
}

function collectUp(graph: TypedGraph<IObserverTree, {}>, node: IObserverTree): IObserverTree[] {
  let inEdges = graph.inEdges(node.id)
  if (inEdges && inEdges.length >= 1) {
    return [node].concat(collectUp(graph, graph.node(inEdges[0].v)))
  }
  return [node]
}
function collectDown(graph: TypedGraph<IObserverTree, {}>, node: IObserverTree): IObserverTree[] {
  let outEdges = graph.outEdges(node.id)
  if (outEdges && outEdges.length === 1) {
    return [node].concat(collectDown(graph, graph.node(outEdges[0].w)))
  }
  return [node]
}

function getFlow(graph: TypedGraph<IObserverTree, {}>, ...ids: string[], ) {

  // let id = graph.inEdges(ids[0])
  let focussed = graph.node(ids[0])
  return [
    ...collectUp(graph, focussed).slice(1).reverse(),
    focussed,
    ...collectDown(graph, focussed).slice(1),
  ]
}

export function graph(layout: Layout, viewState: ViewState, graphs: Graphs, sequence: number): {
  svg: VNode, clicks: Rx.Observable<string[]>, groupClicks: Rx.Observable<string>,
} {
  if (typeof window === "object") {
    (window as any).graphs = graphs
  }
  let graph = graphs.main
  console.log(layout)

  // Calculate SVG bounds
  let xmax = layout
    .flatMap(level => level.nodes)
    .reduce((p: number, n: { x: number }) => Math.max(p, n.x), 0) as number
  let ymax = layout
    .flatMap(level => level.nodes)
    .reduce((p: number, n: { y: number }) => Math.max(p, n.y), 0) as number

  let xPos = (x: number) => (2 + xmax) * mx - (mx + mx * x)
  let yPos = (y: number) => (my / 2 + my * y)

  // tslint:disable-next-line:no-unused-variable
  function spath(ps: { x: number, y: number }[]): string {
    return "M" + ps.map(({ x, y }) => `${xPos(x)} ${yPos(y)}`).join(" L ")
  }

  function bpath(ps: { x: number, y: number }[]): string {
    // simple:
    // return "M" + [ps[0], ps[1]].map((p) => `${mu + mu * p.x} ${mu + mu * p.y}`).join(" L ")
    let last = ps[ps.length - 1]
    return "M " + mapTuples(ps, (a, b) =>
      `${xPos(a.x)} ${yPos(a.y)} C ${xPos(a.x)} ${yPos(.5 + a.y)}, ${xPos(b.x)} ${yPos(-0.5 + b.y)}, `
    ).join("") + ` ${xPos(last.x)} ${yPos(last.y)}`
  }

  // Collect clicks in Subject
  let clicks = new Rx.Subject<string[]>()
  let groupClicks = new Rx.Subject<string>()

  // Determine shown subscription flow
  let flow: IObserverTree[] = []
  if (
    viewState.focusNodes.every(n => graphs.subscriptions.hasNode(n)) &&
    mapTuples(viewState.focusNodes, (v, w) => graphs.subscriptions.hasEdge(v, w))
  ) {
    flow = viewState.focusNodes.map(n => graphs.subscriptions.node(n))
  }

  let flowPathIds = flow.map(_ => _.id)
  console.log("flow", flow, flowPathIds)

  let handleClick = (v: string, w: string) => clicks.onNext(flowPathIds.indexOf(v) >= 0 && flowPathIds.indexOf(w) >= 0 ?
    [] :
    getFlow(graphs.subscriptions, v, w).map(_ => _.id)
  )

  // Render edges
  function edge(edge: { v: string, w: string, points: { x: number, y: number }[] }): VNode {
    let { v, w, points } = edge
    // let labels = (graph.edge(v, w) || { labels: [] }).labels || []

    let isHigher = false;
    // labels.map(_ => _.edge.label).map((_: any) => _.type).indexOf("higherOrderSubscription sink") >= 0

    let isSelected = flowPathIds.indexOf(w) >= 0 && flowPathIds.indexOf(v) >= 0
    let alpha = isSelected ? 0.3 : 0.1
    let isBlueprint = v.indexOf("-blueprint") >= 0

    return h("path", {
      attrs: {
        d: bpath(points),
        fill: "transparent",
        id: `${v}/${w}`,
        stroke: isBlueprint ? "rgba(0, 125, 214, 0.33)" : (isHigher ? `rgba(200,0,0,${alpha})` : `rgba(0,0,0,${alpha})`),
        "stroke-width": 10,
      },
      hook: { prepatch: MorphModule.prepare },
      key: `${v}/${w}`,
      on: {
        click: () => handleClick(v, w),
        mouseover: () => debug(v, w, graph.edge(v, w)),
      },
      style: {
        transition: "d 1s",
      },
    })
  }

  type RenderNode = { id: string, x: number, y: number }

  // Render nodes
  function circle(cluster: { node: IObservableTree, dots: RenderNode[] }): { svg: VNode[], html: VNode[] } {
    let node = cluster.node
    let text = nodeLabel(node)
    let isSelected = cluster.dots.some(item => flowPathIds.indexOf(item.id) >= 0)
    let isBlueprint = node.id.indexOf("-blueprint") >= 0
    let colors = isBlueprint ? {
      fill: "white",
      stroke: "rgba(0, 125, 214, 1)",
    } : {
        fill: colorIndex(parseInt(node && node.id || cluster.dots[0].id, 10)),
        stroke: undefined,
      }

    // tslint:disable-next-line:no-unused-variable
    // let shade = h("circle", {
    //   attrs: {
    //     cx: mu + mu * item.x,
    //     cy: mu + mu * item.y + 1,
    //     fill: "rgba(0,0,0,.3)",
    //     r: 5,
    //   },
    //   key: `circle-shade-${item.id}`,
    //   style: { transition: "all 1s" },
    // })

    let bounds = {
      x1: Math.min(...cluster.dots.map(_ => xPos(_.x))),
      x2: Math.max(...cluster.dots.map(_ => xPos(_.x))),
      y: yPos(cluster.dots[0].y),
    }

    let rect = h("path", {
      attrs: {
        d: spath(cluster.dots),
        id: `cluster-${node.id}`,
        stroke: colors.fill,
        "stroke-width": 10,
      },
      hook: { prepatch: MorphModule.prepare },
      key: `cluster-${node.id}-${bounds.y}`,
      style: {
        transition: "d 1s",
      },
    })

    let circ = cluster.dots.map(item => h("circle", {
      attrs: {
        cx: xPos(item.x),
        cy: yPos(item.y),
        fill: colors.fill,
        id: `cluster-${node.id}/circle-${item.id}`,
        r: 5,
        stroke: colors.stroke,
      },
      key: `cluster-${node.id}/circle-${item.id}`,
      on: {
        click: (e: any) => clicks.onNext(getFlow(graphs.subscriptions, item.id).map(_ => _.id)),
        mouseover: (e: any) => debug(item.id, graph.node(item.id)),
      },
      style: { transition: "all 1s" },
    }))

    let svg = [rect, /*shade, */...circ]

    let html = [h("div", {
      attrs: { class: `graph-label ${isSelected ? "focus" : ""}` },
      key: `overlay-${cluster.node.id}`,
      on: {
        // click: (e: any) => cluster.dots[0].reverse().forEach(item => clicks.onNext(item.id)),
        mouseover: (e: any) => debug(cluster, cluster.node),
      },
      style: {
        left: `${bounds.x1}px`,
        // "padding-left": `${mu * (bounds.x2 - bounds.x1)}px`,
        top: `${bounds.y}px`,
        "padding-left": `${bounds.x2 - bounds.x1}px`,
        transition: "all 1s",
        "box-sizing": "content-box",
      },

    }, [h("span", text)])]

    // let html = cluster.dots.map(item => h("div", {
    //   attrs: { class: `graph-label ${isSelected ? "focus" : ""}` },
    //   key: `overlay-${item.id}`,
    //   on: {
    //     click: (e: any) => clicks.onNext(item.id),
    //     mouseover: (e: any) => debug(item.id, graph.node(item.id)),
    //   },
    //   style: {
    //     left: `${mu + mu * item.x}px`,
    //     top: `${mu + mu * item.y}px`,
    //     transition: "all 1s",
    //   },
    // }, [h("span", text)]))

    return { html: [...html], svg }
  }

  // Cluster layout nodes
  let ns = layout[0].nodes.reduce(({ list, last }, n) => {
    let obs = getObservable(n.id, graphs.main, graphs.subscriptions) || n
    if (last && last[0] === obs.id && last[1] === n.y) {
      list.slice(-1)[0].dots.push(n)
    } else {
      list.push({ dots: [n], node: obs })
    }
    return { list, last: [obs.id, n.y] }
  }, {
      last: null,
      list: [] as { node: { id: string }, dots: RenderNode[] }[],
    }).list.map(circle)

  let elements = [
    // h("g", gps),
    h("g", layout.flatMap((level, levelIndex) => level.edges.map(edge)).sort(vnodeSort).filter(v => {
      if (typeof v === "undefined") {
        console.warn("emitting undefined as child vnode")
      }
      return typeof v !== "undefined"
    })),
    h("g", ns.flatMap(n => n.svg).sort(vnodeSort).filter(v => {
      if (typeof v === "undefined") {
        console.warn("emitting undefined as child vnode")
      }
      return typeof v !== "undefined"
    })),
  ]

  let svg = h("svg", {
    attrs: {
      id: "structure",
      version: "1.1",
      xmlns: "http://www.w3.org/2000/svg",
    },
    style: {
      height: (ymax + 1) * my,
      left: 0,
      position: "absolute",
      top: 0,
      width: (xmax + 2) * mx,
    },
  }, elements.concat(defs()))

  let mask = h("div", {
    attrs: {
      id: "structure-mask",
    },
    style: {
      height: `${(ymax + 1) * my + 60}px`,
      position: "relative",
      width: `${(xmax + 2) * mx}px`,
    },
  }, [svg].concat(ns.flatMap(n => n.html)))

  let panel = h("div", [mask])

  // Optionally show flow
  let diagram = [h("div")]
  if (flow.length) {
    diagram = renderMarbles(
      flow.flatMap(observer => [observer.observable, observer]),
      viewState,
      layout[0].nodes.filter(n => n.id === flow[0].id).slice(0, 1).map(n => yPos(n.y))[0]
    )
  }

  let app = h("app", { key: `app-${sequence}`, style: { width: `${((xmax + 2) * mx + 300)}px` } }, [
    h("master", panel),
    h("detail", diagram),
  ])

  return {
    svg: app,
    clicks,
    groupClicks,
  }
}

function collect(start: string, f: (start: string) => string[]): string[] {
  return f(start).flatMap(n => [n].concat(collect(n, f)))
}

const colors = generateColors(40)
function colorIndex(i: number, alpha: number = 1) {
  if (typeof i === "undefined" || isNaN(i)) { return "transparent" }
  let [r, g, b] = colors[i % colors.length]
  return alpha === 1 ? `rgb(${r}, ${g}, ${b}) ` : `rgba(${r}, ${g}, ${b}, ${alpha}) `
}
(window as any).colors = colors

const defs: () => VNode[] = () => [h("defs", [
  h("filter", {
    attrs: { height: "200%", id: "dropshadow", width: "200%" },
  }, [
      h("feGaussianBlur", { attrs: { in: "SourceAlpha", stdDeviation: "2" } }),
      h("feOffset", { attrs: { dx: 0, dy: 0, result: "offsetblur" } }),
      h("feMerge", [
        h("feMergeNode"),
        h("feMergeNode", { attrs: { in: "SourceGraphic" } }),
      ]),
    ]),
  h("marker", {
    attrs: {
      id: "arrow",
      markerHeight: 10,
      markerUnits: "strokeWidth",
      markerWidth: 10,
      orient: "auto",
      overflow: "visible",
      refx: 0, refy: 3,
    },
  }, [h("path", { attrs: { d: "M-4,-2 L-4,2 L0,0 z", fill: "inherit" } })]),
  h("marker", {
    attrs: {
      id: "arrow-reverse",
      markerHeight: 10,
      markerUnits: "strokeWidth",
      markerWidth: 10,
      orient: "auto",
      overflow: "visible",
      refx: 0, refy: 3,
    },
  }, [h("path", { attrs: { d: "M0,0 L4,2 L4,-2 z", fill: "blue" } })]),
])]

function vnodeSort(vna: VNode, vnb: VNode): number {
  return vna.key.toString().localeCompare(vnb.key.toString())
}

function renderMarbles(nodes: (IObservableTree | IObserverTree)[], viewState: ViewState, offset: number = 0): VNode[] {
  let coordinator = new MarbleCoordinator()
  let allEvents: IEvent[] = nodes.flatMap((n: any) => n && "events" in n ? n.events as IEvent[] : [])
  coordinator.add(allEvents)
  console.log("All events", allEvents)

  let heights = nodes.map(tree => (tree && "events" in tree) ? 60 : 40)
  let height = heights.reduce((sum, h) => sum + h, 0)

  let root = h("div", {
    attrs: {
      id: "marbles",
      style: `min-width: ${u * 3}px; height: ${height}px; margin-top: ${(offset - heights[0] / 2)}px`,
    },
  }, nodes.flatMap((node, i) => {
    let clazz = "operator withoutStack"
    if (!node) {
      return [h("div", { attrs: { class: clazz } }, "Unknown node")]
    }

    if (node && "events" in node) {
      let events: IEvent[] = (node as IObserverTree).events
      return [coordinator.render(events, debug)]
    } else {
      let obs = node as IObservableTree
      let name = obs.names && obs.names[obs.names.length - 1]
      let call = obs.calls && obs.calls[obs.calls.length - 1]
      let box = h("div", { attrs: { class: clazz } }, [
        h("div", [], call && call.method ? `${call.method} (${call.args})` : name),
        h("div", [], "stackFrame locationText"),
      ].filter((_, idx) => idx === 0))

      return [box]
    }
  }))
  return [root]
}

// tslint:disable:no-conditional-assignment
function debug(...args: any[]) {
  let panel: HTMLElement
  if (typeof document === "object" && (panel = document.getElementById("debug"))) {
    panel.innerText = args.map(a => jsonify(a)).join("\n")
  } else {
    console.log.apply(console, args)
  }
}
