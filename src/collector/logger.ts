import "../utils"
import { ICallRecord, callRecordType } from "./callrecord"
import { Event, IEvent } from "./event"
import { ILens, lens } from "./lens"
import * as Rx from "rx"

const ErrorStackParser = require("error-stack-parser")

function isStream(v: Rx.Observable<any>): boolean {
  return v instanceof (<any>Rx).Observable
}

interface IAscendResults {
  items: any[]
  ascend: () => IAscendResults
}

function ascend(obj: any | any[]): IAscendResults {
  let objs: any[] = Array.isArray(obj) ? obj : [obj]
  let items = objs
    .map(_ => Object.keys(_).map(key => _[key]))
    .reduce((list, n) => list.concat(n, []))
  return {
    items,
    ascend: () => ascend(items),
  }
}

function ascendingFind(target: any, test: (target: any) => boolean, maxLevel = 10): any | null {
  if (test(target)) { return target }
  let result: IAscendResults = ascend(target)
  let level = 0
  do {
    let finding = result.items.find(test)
    if (typeof finding !== "undefined") { return finding }
    result = result.ascend()
    level++
  } while (level < maxLevel)
}

// Expose protected properties of Observers
declare module "rx" {
  export interface Observable<T> {
    source?: Observable<any>
  }
  export interface Observer<T> {
    source?: Observable<any>
    o?: Observer<any>
    parent?: Observer<any>
  }
}

export class AddStackFrame {
  public id: number
  public stackframe: StackFrame
}

export class AddObservable {
  public id: number
  public callParent?: number
  public parents?: number[]
  public method?: string
  public stack?: number
  public arguments?: IArguments

  public inspect(depth: number, opts?: any): string {
    return `AddObservable(${this.method || this.constructor.name}, id: ${this.id})`
  }
  public toString() {
    return this.inspect(0)
  }
}

export class AddSubscription {
  public id: number
  public observableId: number
  public scopeId?: number
}

export class AddEvent {
  public subscription: number
  public event: IEvent
}

export class AddScopeLink {
  public id: number
  public scopeObservable: number
  public observable: number
}

export interface RxCollector {
  before(record: ICallRecord, parents?: ICallRecord[]): Collector
  after(record: ICallRecord): void
  wrapHigherOrder<T>(subject: Rx.Observable<any>, fn: Function): (arg: T) => T
}

export interface ICollector {
  data: (AddStackFrame | AddObservable | AddSubscription | AddEvent | AddScopeLink)[]
  indices: {
    observables: { [id: number]: { childs: number[], subscriptions: number[] } },
    stackframes: { [source: string]: number },
    subscriptions: { [id: number]: { events: number[], links: number[] } },
  }
}

export default class Collector implements RxCollector, ICollector {

  public static collectorId = 0
  public static reset() {
    this.collectorId = 0
  }

  public collectorId: number
  public hash: string

  public indices = {
    observables: {} as { [id: number]: { childs: number[], subscriptions: number[], inner: number[] } },
    stackframes: {} as { [source: string]: number },
    subscriptions: {} as { [id: number]: { events: number[], links: number[] } },
  }

  public data: (AddStackFrame | AddObservable | AddSubscription | AddEvent | AddScopeLink)[] = []

  private queue: ICallRecord[] = []

  public constructor() {
    this.collectorId = Collector.collectorId++
    this.hash = this.collectorId ? `__hash${this.collectorId}` : "__hash"
  }

  public lens(): ILens<{}> {
    return lens(this)
  }

  public before(record: ICallRecord, parents?: ICallRecord[]): Collector {
    this.queue.push(record)
    return this
  }

  public after(record: ICallRecord) {

    // Trampoline
    if (this.queue[0] === record) {
      this.queue.shift()
    } else if (this.queue.length > 0) {
      return
    }

    switch (callRecordType(record)) {
      case "setup": {
        this.observable(record.returned, record)
        break
      }

      case "subscribe": {
        let observer: Rx.Observer<{}> = record.arguments[0] && typeof record.arguments[0] === "object" ?
          record.arguments[0] as Rx.Observer<any> :
          record.returned

        // Add higher order links
        let scopeId = undefined
        // if (observer && observer.source instanceof <any>Rx.Observable && observer.o) {
        //   let sink: Rx.Observable<{}> = observer.source
        //   let source: Rx.Observable<{}> = record.subject
        //   let sinkNode = this.data[this.observable(sink)] as AddObservable
        //   let sourceNode = this.data[this.observable(source)] as AddObservable
        //   if (sinkNode && sinkNode.parents.indexOf(sourceNode.id) === -1) {
        //     let sinkId = this.subscription(observer.o, observer.source)
        //     scopeId = sinkId
        //   }
        // }
        if (record.subject.scope) {
          let found = ascendingFind(record.arguments[0], (o) => {
            return this.observableForObserver(o) && true
          })
          scopeId = this.id(found).get()
          // console.log("subscribe scope", record.subject.scope, found, this.observableForObserver(found))
        }

        let sourceId
        if (observer && record.subject) {
          sourceId = this.subscription(observer, record.subject, scopeId)
        }
      }
        break

      // fallthrough on purpose
      case "event":
        let event = Event.fromRecord(record)
        if (event && event.type === "subscribe") {
          return
        }
        let oid = this.id(record.subject).get()
        if (typeof oid !== "undefined") {
          let node = new AddEvent()
          node.event = event
          node.subscription = oid
          this.data.push(node)
          this.indices.subscriptions[oid].events.push(this.data.length - 1)
        }
        break

      default:
        throw new Error("unreachable")
    }

    // Run trampoline
    if (this.queue.length) {
      this.queue.splice(0, this.queue.length).forEach(this.after.bind(this))
    }
  }

  public wrapHigherOrder(subject: Rx.Observable<any>, fn: Function | any): Function | any {
    let self = this
    if (typeof fn === "function") {
      return function wrapper(val: any, id: any, subjectSuspect: Rx.Observable<any>) {
        let result = fn.apply(this, arguments)
        if (typeof result === "object" && isStream(result) && subjectSuspect) {
          // self.link(subjectSuspect, result)
          return self.proxy(result)
        }
        return result
      }
    }
    return fn
  }

  private pretty(o: Rx.Observable<any> | Rx.Observer<any> | any): string {
    let id = this.id(o).get()
    if (typeof id !== "undefined") {
      let node = this.data[id]
      if (node instanceof AddSubscription) {
        let obs = this.data[node.observableId] as AddObservable
        return `${o.constructor.name}(${id}, observable: ${obs})`
      }
      if (node instanceof AddEvent) {
        let oid = (<AddSubscription>this.data[node.subscription]).observableId
        return `${node.event.type}(subscription: ${node.subscription}, observable: ${oid})`
      }
      if (node instanceof AddObservable) {
        return `${o.constructor.name}(${id})`
      }
    }
    return `anonymous ${o.constructor.name}`
  }

  private proxy<T>(target: T): T {
    let link = new AddScopeLink()
    link.id = this.data.length
    this.data.push(link)

    return new Proxy(target, {
      get: (obj: any, name: string) => {
        if (name === "scope") { return link.id }
        if (name === "link") { return link }
        if (name === "original") { return target }
        return obj[name]
      },
    })
  }

  private stackFrame(record: ICallRecord): number {
    if (typeof record === "undefined" || typeof record.stack === "undefined") {
      return undefined
    }
    // Code Location
    let stack = ErrorStackParser.parse(record).slice(1, 2)[0]
    let id = this.indices.stackframes[stack]
    if (typeof id === "undefined") {
      this.indices.stackframes[stack] = id = this.data.length
      let node = new AddStackFrame()
      node.id = id
      node.stackframe = stack
      this.data.push(node)
    }
    return id
  }

  private observableForObserver(observer: Rx.Observer<any>): AddObservable {
    let id = this.id(observer).get()
    if (typeof id === "undefined") { return }
    let node = this.data[id]
    if (node instanceof AddSubscription) {
      node = this.data[node.observableId]
      return node instanceof AddObservable && "method" in node ? node : undefined
    }
    return undefined
  }

  private enrichWithCall(node: AddObservable, record: ICallRecord, observable: Rx.Observable<any>) {
    if (typeof node.method !== "undefined") {
      return
    }
    node.stack = this.stackFrame(record)
    node.arguments = record && record.arguments
    node.method = record && record.method

    // Record upstream nested observables (eg flatMap's inner FlatMapObservable)
    // let possiblyNested = this.recurseWhile<Rx.Observable<any>>(
    //   t => (<any>t).source,
    //   t => t && typeof this.id(t).get() === "undefined",
    //   observable)
    // possiblyNested.slice(1).reduce((callParent, obs) => {
    //   return this.observableWithCallParent(obs, callParent)
    // }, node.id)

    // Add call-parent
    if (record.parent && record.subject === record.parent.subject) {
      node.callParent = this.id(record.parent.returned).get()
    }

    let parents = [record.subject].concat(record.arguments)
      .filter(isStream)
      .map((arg) => this.observable(arg))
    node.parents = parents

    this.indices.observables[node.id] = { childs: [], inner: [], subscriptions: [] }
    parents.forEach(parent => {
      let index = this.indices.observables[parent]
      if (typeof index !== "undefined") {
        index.childs.push(node.id)
      }
    })
  }

  // private recurseWhile<T>(generator: (t: T) => T, filterfn: (t: T) => boolean, seed: T): T[] {
  //   if (filterfn(seed)) {
  //     return [seed].concat(this.recurseWhile(generator, filterfn, generator(seed)))
  //   } else {
  //     return []
  //   }
  // }

  // private observableWithCallParent(obs: Rx.Observable<any>, callParent: number): number {
  //   let node: AddObservable
  //   if (typeof this.id(obs).get() === "undefined") {
  //     node = new AddObservable()
  //     node.id = this.data.length
  //     node.method = obs.constructor.name
  //     node.parents = [];
  //     this.data.push(node)
  //   } else {
  //     node = this.data[this.id(obs).get()] as AddObservable
  //   }
  //   (<any>node).callParent = callParent || "Fucker!"
  //   return node.id
  // }

  private observable(obs: Rx.Observable<any>, record?: ICallRecord): number {
    let existingId = this.id(obs).get()
    if (
      typeof record !== "undefined" &&
      typeof existingId !== "undefined" &&
      typeof this.data[existingId] !== "undefined"
    ) {
      this.enrichWithCall(this.data[existingId] as AddObservable, record, obs)
    }

    return (this.id(obs).getOrSet(() => {
      if (typeof record !== "undefined") {
        let node = new AddObservable()
        node.id = this.data.length
        node.parents = []
        this.data.push(node)
        this.enrichWithCall(node, record, obs)
        return node.id
      } else {
        return undefined
      }
      // else {
      //   (<any>node).original = obs;
      //   (<any>node).originalName = obs.constructor.name;
      //   (<any>node).originalRecordLocation = (new Error()).stack.replace(
      //     /\/Users\/hbanken\/Dropbox\/Afstuderen\/RxFiddle\/app\//g, "")
      // }
    }))
  }

  private subscription(sub: Rx.Observer<any>, observable: Rx.Observable<any>, scopeId?: number): number {
    return this.id(sub).getOrSet(() => {
      let id = this.data.length
      let node = new AddSubscription()
      this.data.push(node)
      node.id = id
      node.observableId = this.observable(observable)
      if (typeof scopeId !== "undefined") {
        node.scopeId = scopeId
      }

      this.indices.subscriptions[id] = { events: [], links: [] }
      let index = this.indices.observables[node.observableId]
      if (typeof index !== "undefined") {
        index.subscriptions.push(id)
      }

      return id
    })
  }

  private id<T>(obs: T) {
    return {
      get: () => typeof obs !== "undefined" && obs !== null ? (<any>obs)[this.hash] : undefined,
      getOrSet: (orSet: () => number) => {
        if (typeof (<any>obs)[this.hash] === "undefined") {
          (<any>obs)[this.hash] = orSet()
        }
        return (<any>obs)[this.hash]
      },
      set: (n: number) => (<any>obs)[this.hash] = n,
    }
  }

  private findLink(parent: Rx.Observer<any>, onto: Rx.Observable<any>, subscriber: Rx.Observer<any>): AddScopeLink | null {
    let pD = this.id(parent).get()
    if (typeof pD === 'undefined') {
      console.log("pD or iD undefined,", pD)
      return
    } else {
      console.log(pD)
    }
    let pO = (<AddSubscription>this.data[pD]).observableId
    let iO = this.id(onto).get().observableId
    let links = this.indices.observables[pO] && this.indices.observables[pO].inner
      .map(i => this.data[i] as AddScopeLink)
      .filter(sl => sl.observable === iO) || []
    if (links.length) {
      links.length > 1 && console.log("found multiple links", links)
      return links[0]
    } else {
      console.log("No links founds")
    }
  }

  private link(root: Rx.Observable<any>, child: Rx.Observable<any>) {
    let link = new AddScopeLink()
    link.scopeObservable = this.observable(root)
    link.observable = this.observable(child)
    link.id = this.data.length
    this.data.push(link)

    let rev = this.indices.observables[this.observable(root)]
    rev && rev.inner.push(link.id)

    // let link = new AddLink()
    // link.sinkSubscription = this.observable(root)
    // link.sourceSubscription = this.observable(child)
    // this.data.push(link)

    // let index = this.indices.subscriptions[link.sourceSubscription]
    // if (typeof index !== "undefined") {
    //   index.links.push(link.sinkSubscription)
    // }
  }

  private linkSubs(source: AddSubscription, sink: AddSubscription) {
    console.log("link subscriptions", source, sink)

    let link = new AddScopeLink()

    // link.sourceSubscription = source.id
    // link.sinkSubscription = sink.id
    this.data.push(link)

    // let index = this.indices.subscriptions[link.sourceSubscription]
    // if (typeof index !== "undefined") {
    //   index.links.push(link.sinkSubscription)
    // }
  }
}
