import { ICallRecord, ICallStart, callRecordType } from "../../collector/callrecord"
import { RxCollector, elvis } from "../../collector/collector"
import { Event, IEvent, Timing } from "../../collector/event"
import { formatArguments } from "../../collector/logger"
import {
  IObservableTree, IObserverTree, ISchedulerInfo, ITreeLogger,
  ObservableTree, ObserverTree, SchedulerInfo, SchedulerType, SubjectTree,

} from "../../oct/oct"
import { getPrototype } from "../../utils"
import { isObservable, isObserver, isScheduler, isSubject } from "./instrumentation"
import * as Rx from "rxjs"
import { Observable } from "rxjs"
import { IScheduler } from "rxjs/Scheduler"

let debug = false

type Role = "observable" | "observer" | "scheduler"

function getScheduler<T>(obs: Observable<T>, record?: ICallStart): IScheduler | undefined {
  return (obs as any).scheduler ||
    (obs as any)._scheduler ||
    record && ([].filter.call(record.arguments || [], isScheduler)[0])
}

class SequenceTicker {
  public last = 0
  public used = false

  public next(): void {
    if (this.used) {
      this.used = false
      this.last++
    }
  }
  public get(): number {
    this.used = true
    return this.last
  }
}

export class TreeCollector implements RxCollector {
  public call: ICallRecord
  public symbol: symbol
  public subSymbol: symbol
  public nextId = 1
  public logger: ITreeLogger
  private eventSequencer = new SequenceTicker()

  private wireStarts: WireStart[] = []
  private wires: Wire[] = []

  public otree: IObservableTree[] = []
  public stree: IObserverTree[] = []

  private schedulers: { scheduler: IScheduler, info: ISchedulerInfo }[] = []
  private scheduler?: { scheduler: IScheduler, info: ISchedulerInfo }

  public constructor(logger: ITreeLogger) {
    this.logger = logger
    this.symbol = Symbol("tree")
    this.subSymbol = Symbol("tree2")
  }

  public schedule(scheduler: IScheduler, method: string, action: Function, state: any): Function | undefined {
    return
    // let info = this.tag(scheduler)
    // let self = this
    // if (method.startsWith("schedule") && method !== "scheduleRequired") {
    //   // tslint:disable-next-line:only-arrow-functions
    //   return function () {
    //     let justAssigned = self.scheduler = { scheduler, info: info as ISchedulerInfo }
    //     self.eventSequencer.next()
    //     let result = action.apply(this, arguments)
    //     if (self.scheduler === justAssigned) {
    //       self.scheduler = undefined
    //     }
    //     return result
    //   }
    // }
  }

  public before(record: ICallStart, parents?: ICallStart[]): this {
    // tag all encountered Observables & Subscribers
    [record.subject, ...record.arguments].forEach(this.tag.bind(this, undefined))

    if (callRecordType(record) === "event" && isObserver(record.subject)) {
      let event = Event.fromRecord(record, this.getTiming())
      if (event) {
        let observer = this.tag("observer", record.subject)
        this.addEvent(observer, event, record.arguments[0])
      }
    }
    return this
  }

  public after(record: ICallRecord): void {
    this.call = record;
    // tag all encountered Observables & Subscribers
    [record.returned].forEach(t => this.tag(undefined, t, record))

    if (isObservable(record.returned)) {
      this.linkSources(record.returned)

      let shouldName = isFirstOpOntoSubject(record) && (
        // b = a.map(lambda) => linked by source property
        isSource(record.subject, record.returned) ||
        // Observable.of() has record.subject == static Observable
        !isObservable(record.subject) && !hasSource(record.returned)
      )

      if (shouldName) {
        let tree = this.tag("observable", record.returned)
        tree.addMeta({
          calls: {
            args: formatArguments(record.arguments),
            method: record.method,
            subject: `callRecord.subjectName ${
            this.hasTag(record.subject) &&
            this.tag("observable", record.subject).id
            }`,
          },
        })
      }
    }

    if (callRecordType(record) === "subscribe") {
      if (isObserver(record.arguments[0])) {
        this.linkSubscribeSource(record.arguments[0], record.subject)
        this.linkSinks(record.arguments[0])
      } else if (isObserver(record.returned)) {
        this.linkSubscribeSource(record.returned, record.subject)
        this.linkSinks(record.returned)
      }
    }
  }

  public getEventReason(record: ICallStart): string | undefined {
    // return [record.parent, record.parent && record.parent.parent]
    //   .filter(r => r && isObserver(r.subject) && this.hasTag(r.subject))
    //   .map(r => this.tag(r.subject).id)[0]
    return
  }

  public addEvent(observer: IObserverTree, event: IEvent, value?: any) {
    if (typeof event === "undefined") { return }
    // Enrich higher order events
    if (event.type === "next" && isObservable(value)) {
      event.value = {
        id: this.tag("observable", value).id,
        type: value.constructor.name,
      } as any as string
    }

    if (!observer.inflow || observer.inflow.length === 0) {
      this.eventSequencer.next()
    }

    event.timing = this.getTiming()
    observer.addEvent(event)
  }

  private hasTag(input: any): boolean {
    return typeof input === "object" && input !== null && typeof input[this.symbol] !== "undefined"
  }

  private tag(role: "observable", input: any, record?: ICallStart): IObservableTree
  private tag(role: "observer", input: any, record?: ICallStart): IObserverTree
  private tag(role: "scheduler", input: any, record?: ICallStart): ISchedulerInfo

  private tag(role: Role | undefined, input: any, record?: ICallStart):
    IObserverTree | IObservableTree | ISchedulerInfo | undefined {
    if (typeof input !== "object" || input === null) {
      return undefined
    }

    let symbol = this.symbol
    if (isSubject(input) && role === "observer") {
      symbol = this.subSymbol
    }

    if (input.hasOwnProperty(symbol) && typeof input[symbol] !== "undefined") {
      return input[symbol]
    }

    if (isSubject(input)) {
      if (role === "observable") {
        let tree = (input as any)[this.symbol] = new ObservableTree(`${this.nextId++}`,
          input.constructor.name, this.logger, this.getScheduler(input))
        this.linkSources(input)
        this.addo(tree)
        this.linkSubject(tree, (input as any)[this.subSymbol])
        return tree
      } else if (role === "observer") {
        let tree = (input as any)[this.subSymbol] = new SubjectTree(`${this.nextId++}`,
          input.constructor.name, this.logger, this.getScheduler(input))
        this.linkSinks(input)
        this.adds(tree)
        this.linkSubject((input as any)[this.symbol], tree)
        return tree
      }
    }
    if (isObservable(input)) {
      let tree = (input as any)[symbol] = new ObservableTree(`${this.nextId++}`,
        input.constructor.name, this.logger, this.getScheduler(input, record)
      )
      this.linkSources(input)
      this.addo(tree)
      return tree
    }
    if (isObserver(input)) {
      let tree = (input as any)[symbol] = new ObserverTree(`${this.nextId++}`,
        input.constructor.name, this.logger)
      this.linkSinks(input)
      this.adds(tree)
      return tree
    }
    if (isScheduler(input)) {
      let scheduler = input as IScheduler
      let clock = scheduler.now()
      let type = schedulerType(input)
      let info = new SchedulerInfo(
        `${this.nextId++}`, getPrototype(scheduler).constructor.name,
        type, clock, this.logger
      );
      (input as any)[symbol] = info;
      this.schedulers.push({ scheduler, info })
      return info
    }
    return
  }

  private adds(tree: IObserverTree) {
    this.stree.push(tree)
  }

  private addo(tree: IObservableTree) {
    this.otree.push(tree)
  }

  private getScheduler<T>(input: Observable<T>, record?: ICallStart): ISchedulerInfo {
    if (isObservable(input) && getScheduler(input, record)) {
      return this.tag("scheduler", getScheduler(input, record))
    }
    return
  }

  private getTiming(): Timing {
    let clocks: { [id: string]: number } = { tick: this.eventSequencer.get() }
    if (this.scheduler) {
      clocks[this.scheduler.info.id] = this.scheduler.scheduler.now()
      return Object.assign({
        scheduler: this.scheduler.info.id,
        clocks,
      })
    }
    return {
      clocks,
      scheduler: "tick",
    }
  }

  private tagObserver(input: any, record?: ICallStart, traverse: boolean = true): IObserverTree[] {
    // if (isObserver(input)) {
    //   let tree = this.tag(input) as IObserverTree

    //   // Find sink
    //   let sinks = getSink(input, record)
    //   sinks.forEach(([how, sink]) => {
    //     tree.setSink([this.tag(sink) as IObserverTree], how)
    //   })

    //   return [tree]
    // }
    return []
  }

  private linkSources<T>(observable: Rx.Observable<T>) {
    let sources = [(observable as any).source, ...((observable as any)._sources || [])]
      .filter(isObservable)
      .map(o => this.tag("observable", o))
    if (sources.indexOf(this.tag("observable", observable)) >= 0) {
      console.log("Reference loop", observable, this.call)
    }
    (this.tag("observable", observable)).setSources(sources)
  }

  private linkSinks<T>(observer: Rx.Observer<T>) {
    if (isObservable(observer)) {
      return
    }
    let sinkOpt = [(observer as any).destination]
      .filter(o => isObserver(o) || isSubject(o))
      .map(o => this.tag("observer", o))
    this.tag("observer", observer).setSink(sinkOpt)
    let parentOpt = [(observer as any).parent]
      .filter(isObserver)
      .map(o => this.tag("observer", o))
    parentOpt.forEach(p => (this.tag("observer", observer)).setOuter(p))
  }

  private linkSubscribeSource<T>(observer: Rx.Observer<T>, observable: Rx.Observable<T>) {
    if (isSubject(observable)) {
      let subjectAsObs = this.tag("observable", observable) as IObservableTree
      let subject = this.tag("observer", observable) as SubjectTree
      if (subjectAsObs.sources.length === 0) {
        subject.addSink([this.tag("observer", observer)])
        this.tag("observer", observer).setObservable([subjectAsObs])
        return
      }
    }
    let stree = this.tag("observer", observer)
    let otree = this.tag("observable", observable)
    stree.setObservable([otree])
  }

  /**
   * Create link representing the domain border crossing of the Subject
   * @param a observable-side
   * @param b observer-side
   */
  private linkSubject(a: IObservableTree, b: IObserverTree) {
    if (typeof a !== "undefined" && typeof b !== "undefined") {
      b.setObservable([a])
    }
  }
}

function printStack(record?: ICallStart): string {
  if (typeof record === "undefined") {
    return ""
  }
  return "\n\t" + `${record.subject.constructor.name}.${record.method}(${formatArguments(record.arguments)})` +
    (record.parent ? printStack(record.parent) : "")
}

function callStackDepth(record: ICallStart): number {
  return typeof record.parent === "undefined" ? 1 : 1 + callStackDepth(record.parent)
}

function generate<T>(seed: T, next: (acc: T) => T | undefined | null): T[] {
  if (typeof seed === "undefined" || seed === null) {
    return []
  } else {
    return [seed, ...generate(next(seed), next)]
  }
}

class Wire {
  // tslint:disable-next-line:no-constructor-vars
  constructor(public call: ICallStart, public from: IObservableTree[], public to: IObservableTree[]) {
    (this as any)._depth = this.depth
  }

  public get depth() {
    let r: (call: ICallStart) => number = (call) =>
      typeof call.parent === "undefined" ||
        callRecordType(call.parent) !== "setup" ?
        0 :
        r(call.parent) + 1
    return r(this.call)
  }
}

class WireStart {
  // tslint:disable-next-line:no-constructor-vars
  constructor(public call: ICallStart, public from: IObservableTree[]) { }
  public to(to: IObservableTree[]) {
    return new Wire(this.call, this.from, to)
  }
}

function isSource<T, R>(source: Rx.Observable<T>, obs: Rx.Observable<R>): boolean {
  return (obs as any).source === source ||
    Array.isArray((obs as any)._sources) && (obs as any)._sources.indexOf(source) >= 0
}

function hasSource<T, R>(obs: Rx.Observable<R>): boolean {
  return (obs as any).source ||
    Array.isArray((obs as any)._sources) && (obs as any)._sources.length > 0
}

function isFirstOpOntoSubject(record: ICallRecord): boolean {
  return !record.parent || record.parent.subject !== record.subject
}

function schedulerType(
  scheduler: Rx.VirtualTimeScheduler |
    Rx.TestScheduler |
    typeof Rx.Scheduler.asap | typeof Rx.Scheduler.animationFrame |
    typeof Rx.Scheduler.async |
    typeof Rx.Scheduler.queue
): SchedulerType {
  if (scheduler instanceof Rx.VirtualTimeScheduler || scheduler instanceof Rx.TestScheduler) {
    return "virtual"
  } else if (scheduler === Rx.Scheduler.asap) {
    return "recursive"
  } else if (scheduler === Rx.Scheduler.async) {
    return "timeout"
  } else if (scheduler === Rx.Scheduler.animationFrame) {
    return "timeout"
  } else if (scheduler === Rx.Scheduler.queue) {
    return "recursive"
  }
}

function derivatedSubject<T>(input: Rx.Subject<T>) {
  return (input as any).source === (input as any).destination
}
