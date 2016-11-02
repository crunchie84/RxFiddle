import "../utils"
import { ICallRecord } from "./callrecord"
import { RxFiddleEdge } from "./edge"
import { IEvent, Event, Subscribe } from "./event"
import { AddEvent, AddScopeLink, AddObservable, AddSubscription, ICollector } from "./logger"
import { RxFiddleNode } from "./node"
import * as rx from "rx"
import * as dagre from "dagre"
import * as snabbdom from "snabbdom"
import { VNode } from "snabbdom"

const ErrorStackParser = require("error-stack-parser")
const h = require("snabbdom/h")
const patch = snabbdom.init([
  require("snabbdom/modules/attributes"),
  require('snabbdom/modules/eventlisteners'),
])

const svgPanZoom = typeof window != "undefined" ? require("svg-pan-zoom") : {}

function isStream(v: Rx.Observable<any>): boolean {
  return v instanceof (<any>Rx)["Observable"]
}

export const HASH = "__hash"
export const IGNORE = "__ignore"

const inst_method = "instrumented"
const inst_file = "instrumentation.js"

// Expose protected properties of Observers
declare module "rx" {
  export interface Observable<T> { }
  export interface Observer<T> {
    source?: Observable<any>
    o?: Observer<any>
  }
}

export type MethodName = string

export interface RxCollector {
  wrapHigherOrder<T>(subject: Rx.Observable<any>, fn: Function): (arg: T) => T
  before(record: ICallRecord, parents?: ICallRecord[]): this
  after(record: ICallRecord): void
}

export class Visualizer {

  public nodes: RxFiddleNode[] = []

  private g = new dagre.graphlib.Graph({ compound: true, multigraph: true })
  private svg: HTMLElement | VNode
  private rendered: number = 0
  private collector: ICollector

  constructor(collector: ICollector, dom?: HTMLElement) {
    this.g.setGraph({})
    this.g.setDefaultEdgeLabel(() => ({}))
    this.svg = dom
    this.collector = collector
  }

  public subGraphs(): Visualizer[] {
    return this.nodes
      .map(n => n.subGraph())
      .filter(n => n && n !== this)
  }

  public recursiveRendered(): number {
    return this.subGraphs().reduce(
      (p, g) => Math.max(p, g.recursiveRendered()),
      this.rendered)
  }

  public layout() {
    this.nodes.forEach(n => n.layout())
    dagre.layout(this.g)
  }

  public size(): { w: number, h: number } {
    if (this.nodes.length == 0) {
      return { w: 10, h: 10 }
    }
    let g = this.g.graph()
    this.layout()
    return { w: g.width, h: g.height }
  }

  public process() {
    console.log("Processing", this.collector.data.length - this.rendered)
    let start = this.rendered
    this.rendered = this.collector.data.length

    for (let i = start; i < this.collector.data.length; i++) {
      let el = this.collector.data[i]

      if (el instanceof AddObservable) {
        this.nodes[el.id] = new RxFiddleNode(`${el.id}`, el.method, null)
        let graph: Visualizer = this
        if (typeof el.callParent !== "undefined") {
          continue
        }
        graph.g.setNode(`${el.id}` + "", this.nodes[el.id])
        for (let p of el.parents.filter(_ => typeof _ !== "undefined")) {
          this.g.setEdge(p.toString(), el.id.toString(), new RxFiddleEdge(this.nodes[p], this.nodes[el.id]))
        }
      }

      if (el instanceof AddSubscription && typeof this.nodes[el.observableId] !== "undefined") {
        this.nodes[el.observableId].addObserver(this.collector.data[el.observableId] as AddObservable, el)

        // Dashed link
        if (typeof el.scopeId !== "undefined") {
          let from = this.nodes[el.observableId]
          let to = this.nodes[(this.collector.data[el.scopeId] as AddSubscription).observableId]
          this.g.setEdge(from.id, to.id, new RxFiddleEdge(from, to, { dashed: true }))
        }
      }

      if (el instanceof AddEvent) {
        let oid = (this.collector.data[el.subscription] as AddSubscription).observableId
        if (typeof this.nodes[oid] === "undefined") { continue }
        for (let row of this.nodes[oid].observers) {
          if ((row[1] as { id: number }).id === el.subscription) {
            row[2].push(el.event)
          }
        }
      }

    }
  }

  public render(): VNode {
    this.process()
    this.rendered = this.collector.data.length
    this.layout()
    if (this.g.nodes().length === 0) {
      return h("g")
    }

    let ns = this.g.nodes().map((id: string) => this.g.node(id).render(patch)).reduce((p, c) => p.concat(c), [])
    let es = this.g.edges().map((e: Dagre.Edge) => {
      let edge = this.g.edge(e)
      return edge.render()
    })
    let childs = es.concat(ns)
    let graph = this.g.graph()

    return h("g", { attrs: { class: "visualizer" } }, childs)
  }

  public run() {
    if (this.svg instanceof HTMLElement) {
      this.svg.innerHTML = ""
    }

    let render = this.render()
    let size = this.size()
    let updated = h("svg", {
      attrs: {
        id: "svg",
        style: "width: 100vw; height: 100vh",
        version: "1.1",
        viewBox: `0 0 ${size.w} ${size.h}`,
        xmlns: "http://www.w3.org/2000/svg",
      },
    }, [render])
    patch(this.svg, updated)
    this.svg = updated
    let instance = svgPanZoom("#svg", { maxZoom: 30 })
  }
  public attach(node: HTMLElement) {
    this.svg = node
    this.step()
  }
  public step() {
    window.requestAnimationFrame(() => this.step())
    if (this.recursiveRendered() === this.collector.data.length) {
      return
    }
    this.run()
  }
}