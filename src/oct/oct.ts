import { IEvent } from "../collector/event"

export type Id = string

export interface MethodCall {
  method: string
  args: IArguments
}

export interface IObservableTree {
  id: Id
  names?: string[]
  calls?: MethodCall[]
  sources?: IObservableTree[]
  tick?: number
  setSources(sources: IObservableTree[]): IObservableTree
  addMeta(meta: any): IObservableTree
}

export interface IObserverTree {
  id: Id
  names?: string[]
  observable: IObservableTree
  sink?: IObserverTree
  inflow?: IObserverTree[]
  events: IEvent[]
  tick?: number
  setSink(sinks: IObserverTree[], name?: string): IObserverTree
  addInflow(inflow: IObserverTree): IObserverTree
  setObservable(observable: IObservableTree[]): IObserverTree
  addEvent(event: IEvent): IObserverTree
}

//                     O->O *-*    | O->S 1-1            | S->S *-*                
export type EdgeType = "addSource" | "setObserverSource" | "addObserverSink"
export type NodeType = "observable" | "subject" | "observer"

export interface ITreeLogger {
  addNode(id: Id, type: NodeType, tick?: number): void
  addMeta(id: Id, meta: any, tick?: number): void
  addEdge(v: Id, w: Id, type: EdgeType, meta?: any): void
}

export class ObservableTree implements IObservableTree {
  public id: Id
  public names?: string[]
  public calls?: MethodCall[]
  public sources?: IObservableTree[]
  public tick?: number

  public logger?: ITreeLogger
  constructor(id: string, name?: string, logger?: ITreeLogger, tick?: number) {
    this.id = id
    this.tick = tick
    if (name) { this.names = [name] }
    if (logger) {
      this.logger = logger
      logger.addNode(id, "observable", tick)
      logger.addMeta(id, { names: name }, tick)
    }
  }

  public setSources(sources: IObservableTree[]): IObservableTree {
    this.sources = sources
    if (this.logger) {
      sources.forEach(s => this.logger.addEdge(s.id, this.id, "addSource", { label: "source" }))
    }
    return this
  }

  public addMeta(meta: any): IObservableTree {
    if (this.logger) {
      this.logger.addMeta(this.id, meta)
    }
    return this
  }

  public inspect(depth: number, opts: any) {
    return `ObservableTree(${this.id}, ${this.names}, ${
      (this.sources || []).map(s => pad(inspect(s, depth + 2, opts), 2))
      })`
  }
}

export class ObserverTree implements IObserverTree {
  public id: Id
  public names?: string[]
  public observable: IObservableTree
  public sink?: IObserverTree
  public inflow?: IObserverTree[]
  public events: IEvent[] = []
  public tick?: number

  public logger?: ITreeLogger
  constructor(id: string, name?: string, logger?: ITreeLogger, tick?: number) {
    this.id = id
    this.tick = tick
    if (name) { this.names = [name] }
    if (logger) {
      this.logger = logger
      logger.addNode(id, "observer", tick)
      logger.addMeta(id, { names: name })
    }
  }

  public setSink(sinks: IObserverTree[], name?: string): IObserverTree {
    if (this.sink === sinks[0]) {
      return this
    }
    this.sink = sinks[0]
    sinks.forEach(s => s.addInflow(this))
    if (this.logger) {
      sinks.forEach(s => this.logger.addEdge(this.id, s.id, "addObserverSink", { label: "sink" + name }))
    }
    return this
  }
  public addInflow(inflow: IObserverTree) {
    this.inflow = this.inflow || []
    if (this.inflow.indexOf(inflow) >= 0) {
      return this
    }
    this.inflow.push(inflow)
    return this
  }
  public setObservable(observable: IObservableTree[]): IObserverTree {
    if (this.observable) {
      if (this.observable !== observable[0]) {
        console.log("Adding second observable to ", this)
        console.log("becoming", observable)
        console.log("was", this.observable)
        console.log("at", new Error().stack.split("\n").slice(0, 4).join("\n"))
      } else {
        return this
      }
    }
    this.observable = observable[0]
    if (this.logger) {
      observable.forEach(o => this.logger.addEdge(o.id, this.id, "setObserverSource", { label: "observable" }))
    }
    return this
  }

  public addEvent(event: IEvent): IObserverTree {
    if (this.logger) {
      this.logger.addMeta(this.id, { events: event }, event.tick)
    }
    return this
  }

  public inspect(depth: number, opts: any) {
    if (depth > 30) {
      return "depth 30 reached"
    }
    if (this.sink) {
      return `ObserverTree(${this.id}, ${this.names}, \n${pad(inspect(this.sink, depth + 1, opts), 1)}\n)`
    } else {
      return `ObserverTree(${this.id}, ${this.names})`
    }
  }
}

function pad(str: string, depth: number): string {
  if (depth <= 0 || !str) {
    return str
  }
  return pad(str.split("\n").map(l => "  " + l).join("\n"), depth - 1)
}

function inspect(i: any, depth: number, opts: any): string {
  if (i && i.inspect) {
    return i.inspect(depth, opts)
  } else if (i && i.toString) {
    return i.toString()
  } else {
    return i
  }
}

export class SubjectTree implements ObservableTree, ObserverTree {
  public id: Id
  public names?: string[]
  public args: IArguments
  public inflow?: IObserverTree[]
  public sources?: IObservableTree[]
  public observable: IObservableTree
  public sink?: IObserverTree
  public sinks?: IObserverTree[]
  public events: IEvent[] = []
  public tick?: number

  // Mixin Observable & Observer methods
  public setSink: (sinks: IObserverTree[], name?: string) => this
  public addInflow: (inflow: IObserverTree) => this
  public setObservable: (observable: IObservableTree[]) => IObserverTree
  public setSources: (sources: IObservableTree[]) => IObservableTree
  public addMeta: (meta: any) => this
  public addEvent: (event: IEvent) => IObserverTree
  public logger?: ITreeLogger

  constructor(id: string, name?: string, logger?: ITreeLogger, tick?: number) {
    this.id = id
    this.tick = tick
    if (name) {
      this.names = [name]
    }
    if (logger) {
      this.logger = logger
      logger.addNode(id, "subject", tick)
      logger.addMeta(id, { names: name })
    }
  }

  public addSink(sinks: IObserverTree[], name?: string) {
    let prev = this.sinks || []
    this.setSink(sinks, name)
    this.sinks = prev.concat(sinks)
    return this
  }

  public inspect(depth: number, opts: any) {
    if (depth > 30) {
      return "Too deep"
    }
    return `SubjectTree(${this.id}, ${this.names}, \n${pad(inspect(this.sink, depth + 2, opts), 2)}\n)`
  }
}

applyMixins(SubjectTree, [ObservableTree, ObserverTree])

function applyMixins(derivedCtor: any, baseCtors: any[]) {
  baseCtors.forEach(baseCtor => {
    Object.getOwnPropertyNames(baseCtor.prototype).forEach(name => {
      // Only mix non-defined's, causing implemented methods to act as overloads. 
      // Allows mixin to have a specialized constructor for example.
      if (typeof derivedCtor.prototype[name] === "undefined") {
        derivedCtor.prototype[name] = baseCtor.prototype[name]
      }
    })
  })
}
