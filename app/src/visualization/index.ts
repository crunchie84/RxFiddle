import { groupBy } from "../collector/graphutils"
import { Edge as EdgeLabel, Message, NodeLabel, EventLabel, ObservableLabel } from "../collector/logger"
import TypedGraph from "../collector/typedgraph"
import { generateColors } from "../color"
import "../object/extensions"
import "../utils"
import layoutf from "./layout"
import { MarbleCoordinator } from "./marbles"
import MorphModule from "./morph"
import * as Rx from "rx"
import { h, init as snabbdom_init } from "snabbdom"
import attrs_module from "snabbdom/modules/attributes"
import class_module from "snabbdom/modules/class"
import event_module from "snabbdom/modules/eventlisteners"
import style_module from "snabbdom/modules/style"
import { VNode } from "snabbdom/vnode"

const patch = snabbdom_init([class_module, attrs_module, style_module, event_module, MorphModule])

export interface DataSource {
  dataObs: Rx.Observable<Message>
}

export type ViewState = {
  focusNodes: string[]
  openGroups: string[]
  openGroupsAll: boolean
}

export type GraphNode = {
  name: string
  labels: NodeLabel[]
}
export type GraphEdge = {
  labels: EdgeLabel[]
}

export type Graphs = {
  main: TypedGraph<GraphNode, GraphEdge>,
  subscriptions: TypedGraph<number, undefined>,
}

export class Grapher {

  public graph: Rx.Observable<Graphs>

  constructor(collector: DataSource) {
    // this.viewState = viewState.startWith(emptyViewState)
    this.graph = collector.dataObs
      .scan(grapherNext, {
        main: new TypedGraph<GraphNode, GraphEdge>(),
        subscriptions: new TypedGraph<number, undefined>(),
      })
    // .combineLatest(this.viewState, this.filter)
  }
}

function setEdge<V, E>(
  v: string | number, w: string | number,
  graph: TypedGraph<V, E>,
  nodeCreate: () => V, value?: E
) {
  v = `${v}`
  w = `${w}`
  if (!graph.hasNode(v)) {
    graph.setNode(v, nodeCreate())
  }
  if (!graph.hasNode(w)) {
    graph.setNode(w, nodeCreate())
  }
  graph.setEdge(v, w, value)
}

export function grapherNext(graphs: Graphs, event: Message) {
  let { main, subscriptions } = graphs
  switch (event.type) {

    case "node": main.setNode(`${event.id}`, {
      labels: [],
      name: event.node.name,
    })
      break

    case "edge":
      let e: GraphEdge = main.edge(`${event.edge.v}`, `${event.edge.w}`) || {
        labels: [],
      }
      e.labels.push(event)

      let edgeLabel = event.edge.label
      if (edgeLabel.type === "subscription sink") {
        setEdge(edgeLabel.v, edgeLabel.w, subscriptions, () => ({}))
      }

      setEdge(event.edge.v, event.edge.w, main, () => ({}), e)
      break

    case "label":
      (main.node(`${event.node}`) || main.node(`${(event.label as EventLabel).subscription}`)).labels.push(event)
      let label = event.label
      if (label.type === "subscription") {
        subscriptions.setNode(label.id.toString(10), event.node)
      }
      break

    default: break
  }

  ; (window as any).graph = graph

  return { main, subscriptions }
}

export default class Visualizer {

  // TODO workaround for Rx.Subject's
  public focusNodes = new Rx.Subject<string[]>()
  public openGroups = new Rx.Subject<string[]>()

  public DOM: Rx.Observable<VNode>
  public get viewState(): Rx.Observable<ViewState> {
    return this.focusNodes.startWith([]).combineLatest(this.openGroups.startWith([]), (fn, og) => ({
      focusNodes: fn,
      openGroups: og,
      openGroupsAll: false,
    }))
  }

  private clicks: Rx.Observable<string>
  private groupClicks: Rx.Observable<string>
  private grapher: Grapher
  private app: HTMLElement | VNode

  constructor(grapher: Grapher, dom?: HTMLElement, controls?: HTMLElement) {
    this.grapher = grapher
    this.app = dom

    let inp = grapher.graph
      .debounce(10)
      .combineLatest(this.viewState, (graphs, state) => {
        let filtered = this.filter(graphs, state)
        return ({
          graphs: filtered,
          layout: layoutf(filtered.main, state.focusNodes),
          viewState: state,
        })
      })
    let { svg, clicks, groupClicks } = graph$(inp)

    this.DOM = svg
    this.clicks = clicks
    this.groupClicks = groupClicks
  }

  public run() {
    this.DOM
      .subscribe(d => this.app = patch(this.app, d))
    this.clicks
      .scan((list, n) => list.indexOf(n) >= 0 ? list.filter(i => i !== n) : list.concat([n]), [])
      .startWith([])
      .subscribe(this.focusNodes)
    this.groupClicks
      .scan((list, n) => list.indexOf(n) >= 0 ? list.filter(i => i !== n) : list.concat([n]), [])
      .startWith([])
      .subscribe(this.openGroups)
  }

  public attach(node: HTMLElement) {
    this.app = node
    this.step()
  }

  public step() {
    this.run()
  }

  private filter(graphs: Graphs, viewState: ViewState): Graphs {
    return {
      main: graphs.main.filterNodes((id, node: GraphNode) => {
        let annotations = (node ? node.labels || [] : [])
          .filter(ann => ann.label.type === "observable")
        if (annotations.length === 0) {
          return true
        }
        return annotations
          .some(ann => !ann.groups.length || ann.groups.slice(-1).some(g => viewState.openGroups.indexOf(`${g}`) >= 0))
        // let groups = node.labels.flatMap(l => l.groups && l.groups.slice(-1) || [])
        // if (groups && groups.length > 0) {
        //   console.log("groups", groups, "testing", groups.slice(-1)
        //     .find(g => viewState.openGroups.indexOf(`${g}`) >= 0))
        // }
        // return viewState.openGroupsAll ||
        //   !groups ||
        //   groups.length === 0 ||
        //   (groups.find(g => viewState.openGroups.indexOf(`${g}`) >= 0) && true)
      }),
      subscriptions: graphs.subscriptions,
    }
  }
}

type In = Rx.Observable<({ layout: Layout, viewState: ViewState, graphs: Graphs })>
type Out = { svg: Rx.Observable<VNode>, clicks: Rx.Observable<string>, groupClicks: Rx.Observable<string> }
function graph$(inp: In): Out {
  let result = inp.map(data => {
    return graph(data.layout, data.viewState, data.graphs)
  }).publish().refCount()

  return {
    clicks: result.flatMap(_ => _.clicks),
    groupClicks: result.flatMap(_ => _.groupClicks),
    svg: result.map(_ => _.svg),
  }
}

type Layout = {
  edges: { points: { x: number, y: number }[], v: string, w: string }[],
  nodes: { id: string, x: number, y: number }[],
}[]

const u = 100
const mu = u / 2

// tslint:disable-next-line:no-unused-variable
function spath(ps: { x: number, y: number }[]): string {
  return "M" + ps.map(({x, y}) => `${mu + mu * x} ${mu + mu * y}`).join(" L ")
}

function bpath(ps: { x: number, y: number }[]): string {
  // simple:
  // return "M" + [ps[0], ps[1]].map((p) => `${mu + mu * p.x} ${mu + mu * p.y}`).join(" L ")
  let last = ps[ps.length - 1]
  return "M " + mapTuples(ps, (a, b) =>
    `${mu + mu * a.x} ${mu + mu * a.y} C ${mu * (1 + a.x)} ${mu * (1.5 + a.y)}, ${mu + mu * b.x} ${mu * (0.5 + b.y)}, `
  ).join("") + ` ${mu + mu * last.x} ${mu + mu * last.y}`
}

export function mapTuples<T, R>(list: T[], f: (a: T, b: T, anr: number, bnr: number) => R): R[] {
  let result = []
  for (let i = 1, ref = i - 1; i < list.length; i++ , ref++) {
    result.push(f(list[ref], list[i], ref, i))
  }
  return result
}

function graph(layout: Layout, viewState: ViewState, graphs: Graphs): {
  svg: VNode, clicks: Rx.Observable<string>, groupClicks: Rx.Observable<string>,
} {
  console.log("Layout", layout)

  let graph = graphs.main

  // Collect clicks in Subject
  let clicks = new Rx.Subject<string>()
  let groupClicks = new Rx.Subject<string>()

  // Determine shown subscription flow
  let flowPath: [string, GraphNode][] = []
  if (viewState.focusNodes.length) {
    let subIds = graph.node(viewState.focusNodes[0])
      .labels
      .map(l => l.label)
      .flatMap(l => l.type === "subscription" ? [l.id] : [])
    let subId = subIds[0]

    // tslint:disable-next-line:max-line-length
    let inn = collect(subId.toString(10), w => graphs.subscriptions.hasNode(w) ? graphs.subscriptions.inEdges(w).map(e => e.v) : [])
    let out = collect(subId.toString(10), v => graphs.subscriptions.hasNode(v) ? graphs.subscriptions.outEdges(v).map(e => e.w) : [])
    let path = inn.reverse().concat([`${subId}`]).concat(out)
    flowPath = path.map(v => [
      graphs.main.hasNode(v) ? v : `${graphs.subscriptions.node(v)}`,
      graphs.main.node(graphs.main.hasNode(v) ? v : `${graphs.subscriptions.node(v)}`)
    ] as [string, GraphNode])
  }

  let flowPathIds = flowPath.map(_ => _[0])
  console.log("flow", flowPath, flowPathIds)

  // Render edges
  function edge(edge: { v: string, w: string, points: { x: number, y: number }[] }): VNode {
    let { v, w, points } = edge
    let labels = (graph.edge(v, w) || { labels: [] }).labels

    let isHigher = labels.map(_ => _.edge.label).map((_: any) => _.type).indexOf("higherOrderSubscription sink") >= 0

    let isSelected = flowPathIds.indexOf(w) >= 0 && flowPathIds.indexOf(v) >= 0
    let alpha = isSelected ? 0.3 : 0.1

    return h("path", {
      attrs: {
        d: bpath(points),
        fill: "transparent",
        id: `${v}/${w}`,
        stroke: isHigher ? `rgba(200,0,0,${alpha})` : `rgba(0,0,0,${alpha})`,
        "stroke-width": 10,
      },
      hook: { prepatch: MorphModule.prepare },
      key: `${v}/${w}`,
      on: { click: () => console.log(v, w, labels) },
      style: {
        transition: "d 1s",
      },
    })
  }

  // Render nodes
  function circle(item: { id: string, x: number, y: number }): { svg: VNode[], html: VNode[] } {
    let node = graph.node(item.id)
    let labels = node.labels || []
    let methods = labels.map(nl => nl.label)
      .filter(label => label.type === "observable")
      .reverse()

    let text = item.id + " " + (methods.map((l: any) => `${l.method}(${l.args})`).join(", ") || node.name || item.id)
    let isSelected = flowPathIds.indexOf(item.id) >= 0

    // tslint:disable-next-line:no-unused-variable
    let shade = h("circle", {
      attrs: {
        cx: mu + mu * item.x,
        cy: mu + mu * item.y + 1,
        fill: "rgba(0,0,0,.3)",
        r: 5,
      },
      key: `circle-shade-${item.id}`,
      style: { transition: "all 1s" },
    })

    let circ = h("circle", {
      attrs: {
        cx: mu + mu * item.x,
        cy: mu + mu * item.y,
        fill: colorIndex(parseInt(item.id, 10)),
        id: `circle-${item.id}`,
        r: 5,
        stroke: "black",
        "stroke-width": isSelected ? 1 : 0,
      },
      key: `circle-${item.id}`,
      on: {
        click: (e: any) => clicks.onNext(item.id),
        mouseover: (e: any) => console.log(item.id, labels),
      },
      style: { transition: "all 1s" },
    })

    let svg = [/*shade, */circ]

    let html = h("div", {
      attrs: { class: `graph-label ${isSelected ? "focus" : ""}` },
      key: `overlay-${item.id}`,
      on: {
        click: (e: any) => clicks.onNext(item.id),
        mouseover: (e: any) => console.log(item.id, labels),
      },
      style: {
        left: `${mu + mu * item.x}px`,
        top: `${mu + mu * item.y}px`,
        transition: "all 1s",
      },
    }, [h("span", text)])

    return { html: [html], svg }
  }

  // Render groups
  let grouped = groupBy(n =>
    n.group,
    layout[0].nodes
      .flatMap(node => (graph.node(node.id).labels || [])
        .flatMap(_ => _.groups)
        .filter(_ => typeof _ === "number")
        .map(group => ({ node, group }))
      )
  )
  let groups = Object.keys(grouped).map(k => ({ group: grouped[k], key: k }))
  let gps = groups
    .flatMap(({ group, key }, index) => group.map(_ => _.node).map(({ x, y}) => h("circle", {
      attrs: {
        cx: mu + mu * x,
        cy: mu + mu * y,
        fill: colorIndex(parseInt(key, 10), .3),
        id: `group-${key}`,
        r: mu / 4,
      },
      key: `group-${key}`,
      style: {
        transition: "all 1s",
      },
    })))

  let ns = layout[0].nodes.map(circle)

  let elements = [
    h("g", gps),
    h("g", layout.flatMap((level, levelIndex) => level.edges.map(edge)).sort(vnodeSort)),
    h("g", ns.flatMap(n => n.svg).sort(vnodeSort)),
  ]

  // Calculate SVG bounds
  let xmax = layout
    .flatMap(level => level.nodes)
    .reduce((p: number, n: { x: number }) => Math.max(p, n.x), 0) as number
  let ymax = layout
    .flatMap(level => level.nodes)
    .reduce((p: number, n: { y: number }) => Math.max(p, n.y), 0) as number

  let svg = h("svg", {
    attrs: {
      id: "structure",
      version: "1.1",
      xmlns: "http://www.w3.org/2000/svg",
    },
    style: {
      height: (ymax + 2) * mu,
      left: 0,
      position: "absolute",
      top: 0,
      width: (xmax + 2) * mu,
    },
  }, elements.concat(defs()))

  let mask = h("div", {
    attrs: {
      id: "structure-mask",
    },
    style: {
      height: `${(ymax + 2) * mu}px`,
      position: "relative",
      width: `${(xmax + 2) * mu}px`,
    },
  }, [svg].concat(ns.flatMap(n => n.html)))

  let controls = h("div", [
    h("div", ["Groups: ", ...groups.flatMap(g => [h("span", {
      on: { click: () => groupClicks.onNext(g.key) },
    }, g.key), ", "])]),
    h("div", ["Open groups: ", ...viewState.openGroups.flatMap(key => [h("span", key), ", "])]),
  ])

  let panel = h("div", [controls, mask])

  // Optionally show flow
  let diagram = [h("div")]
  if (flowPath.length) {
    diagram = renderMarbles(flowPath.map(_ => _[1]))
  }

  let app = h("app", [
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
  return alpha === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
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

function renderMarbles(nodes: GraphNode[]): VNode[] {
  let coordinator = new MarbleCoordinator()
  let all_events: EventLabel[] = nodes.flatMap(n => n.labels).map(l => l.label).flatMap(l => l.type === "event" ? [l] : [])
  coordinator.add(all_events)
  console.log("All events", all_events)

  let root = h("div", {
    attrs: {
      id: "marbles",
      style: `min-width: ${u * 2}px; height: ${u * (1.5 * nodes.length)}px`,
    },
  }, nodes.flatMap((node, i) => {
    let obs = node.labels.map(_ => _.label).reverse().find(_ => _.type === "observable") as ObservableLabel
    let events = node.labels.map(_ => _.label).filter(_ => _.type === "event").map((evl: EventLabel) => evl)

    let clazz = "operator withoutStack"
    let box = h("div", { attrs: { class: clazz } }, [
      h("div", [], obs ? `${obs.method}(${obs.args})` : node.name),
      h("div", [], "stackFrame locationText"),
    ].filter((_, idx) => idx === 0))

    return [box].concat([coordinator.render(events)])
  }))
  return [root]
}