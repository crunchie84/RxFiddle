// tslint:disable:no-constructor-vars
// tslint:disable:object-literal-key-quotes
import { ICallRecord, ICallStart } from "../../collector/callrecord"
import { RxCollector } from "../../collector/collector"

// Allow either external scoped Rx or local imported Rx to be used
import * as RxImported from "rxjs/Rx"
import { IScheduler } from "rxjs/Scheduler"
declare let Rx: any
export let InstrumentedRx: typeof RxImported = typeof Rx === "undefined" ? RxImported : Rx

let i = 0
export default class Instrumentation {
  private subjects: { [name: string]: any; }
  private prototypes: any[] = []
  private open: any[] = []
  private calls: (ICallStart | ICallRecord)[] = []

  constructor(private collector: RxCollector) {
    this.collector = collector
    this.subjects = {
      "Observable": InstrumentedRx.Observable.prototype,
      "ObservableStatic": InstrumentedRx.Observable,
      "SubjectStatic": InstrumentedRx.Subject,
      "Subject": InstrumentedRx.Subject.prototype,
    }
  }

  public setup(target?: any, targetName?: string): void {
    if (typeof target !== "undefined") {
      this.setupPrototype(target, targetName)
    } else {
      Object.keys(this.subjects)
        .forEach(name => this.setup(this.subjects[name], name))
    }
    /* TODO:
     - schedulers
     - constructors
    */
  }

  public teardown(): void {
    let properties: { key: string, target: any }[] = this.prototypes
      .map(target => Object.keys(target).map(key => ({ key, target })))
      .reduce((prev, next) => prev.concat(next), [])

    // Methods
    properties
      .filter(({ key, target }) => typeof target[key] === "function")
      .forEach(({ key, target }) => {
        target[key] = this.deinstrument(target[key])
      })

    // Prototypes
    this.prototypes
      .filter(proto => "__dynamicallyInstrumented" in proto)
      .forEach(proto => delete proto.__dynamicallyInstrumented)

    this.prototypes = []
  }

  public callstacks = [] as ICallRecord[][]

  public ignore = false

  /* tslint:disable:only-arrow-functions */
  /* tslint:disable:no-string-literal */
  /* tslint:disable:no-string-literal */
  public apply(
    originalFn: Function,
    target: any, thisArg: any, argumentsList: any[],
    extras: { [key: string]: string; }
  ): any {
    if (this.ignore) {
      return target.apply(target, argumentsList)
    }

    // find more
    argumentsList
      .filter(hasRxObservablePrototype)
      .filter((v: any) => !isInstrumented(v))
      .forEach((t: any) => this.setupPrototype(t))

    let call: ICallStart = {
      arguments: [].slice.call(argumentsList, 0),
      childs: [],
      id: i++,
      method: extras["methodName"],
      subject: thisArg,
      subjectName: extras["subjectName"],
      tick: 0,
      time: now(),
    }

    // Prepare
    this.calls.push(call)
    if (this.open.length > 0) {
      call.parent = this.open[this.open.length - 1]
      call.parent.childs.push(call)
    }
    this.open.push(call)

    this.callstacks.push(this.open.slice(0))

    // Actual method
    this.ignore = true
    let instanceLogger = this.collector.before(call, this.open.slice(0, -1))
    this.ignore = false
    let returned = target.apply(call.subject, [].map.call(
      call.arguments,
      this.wrap.bind(this)
    ))

    let end: ICallRecord = call as ICallRecord
    end.returned = returned

    this.ignore = true
    instanceLogger.after(end)
    this.ignore = false;

    // find more
    ([end.returned])
      .filter(hasRxObservablePrototype)
      .filter((v: any) => !isInstrumented(v))
      .forEach((t: any) => this.setupPrototype(t))

    // Cleanup
    this.open.pop()
    return end.returned
  }

  /* tslint:disable:only-arrow-functions */
  /* tslint:disable:no-string-literal */
  /* tslint:disable:no-string-literal */
  public instrument(fn: Function, extras: { [key: string]: string; }): Function {
    let self = this

    let instrumented = new Proxy(fn, {
      apply: (target: any, thisArg: any, argumentsList: any[]) => {
        return this.apply(fn, target, thisArg, argumentsList, extras)
      },
      construct: (target: { new (...args: any[]): any }, args) => {
        console.warn("TODO, instrument constructor", target, args)
        return new target(...args)
      },
      get: (target: any, property: PropertyKey): any => {
        if (property === "__instrumentedBy") { return self }
        if (property === "__originalFunction") { return fn }
        return (target as any)[property]
      },
    })
    return instrumented
  }

  public deinstrument(fn: Function): Function {
    return fn.__originalFunction && this.deinstrument(fn.__originalFunction) || fn
  }

  public setupPrototype(prototype: any, name?: string) {
    if (typeof prototype === "undefined") {
      return
    }
    if (typeof name !== "undefined") {
      prototype.__dynamicallyInstrumented = true
    }
    let methods = Object.keys(prototype)
      .filter((key) => typeof prototype[key] === "function")
      .filter(key => !isInstrumented(prototype[key], this))

    if (methods.length) {
      // store, preparing for teardown
      this.prototypes.push(prototype)

      methods.forEach(key => {
        prototype[key] = this.instrument(prototype[key], {
          methodName: key,
          subjectName: name || prototype.constructor.name,
        })
      })
    }
  }

  private wrap<T>(input: T): T {
    if (isObservable(input) && !prototypeIsInstrumented((input as any).prototype)) {
      this.setupPrototype((input as any).prototype, input.constructor.name)
      return input as any
    }
    if (isScheduler(input)) {
      return input
    }
    if (isObserver(input) && !(input as any).__isInstrumentationWrapper) {
      return new Proxy(input, {
        get: (thisArg: any, name: string) => {
          let original = thisArg[name]
          if (name === "__isInstrumentationWrapper") { return true }
          if (name === "hasOwnProperty") { return original }
          if (typeof original === "function") {
            return this.instrument(original, { methodName: name, subjectName: (input as any).constructor.name })
          }
          return original
        },
      })
    }
    if (typeof input === "function" && !isInstrumented(input, this)) {
      return this.instrument(input, {}) as any as T
    }
    return input
  }

}

function now() {
  return typeof performance !== "undefined" ? performance.now() : new Date().getTime()
}

/* tslint:disable:interface-name */
export interface Function {
  caller?: Function
  __originalFunction?: Function | null
  apply(subject: any, args: any[] | IArguments): any
}

function hasRxObservablePrototype(input: any): boolean {
  return typeof input === "object" && InstrumentedRx.Observable.prototype.isPrototypeOf(input)
}

export function isInstrumented(fn: Function, by?: Instrumentation): boolean {
  if (typeof by === "undefined") {
    return ((
      typeof fn.__originalFunction === "function" ?
        1 + (this.isInstrumented(fn.__originalFunction) as any) as number :
        0)
    ) as any as boolean
  }
  if ((fn as any).__instrumentedBy === by) { return true }
  let orig = (fn as any).__originalFunction
  return typeof orig === "function" && isInstrumented(orig, by)
}

function prototypeIsInstrumented(input: any): boolean {
  return typeof input === "object" && input !== null && input.hasOwnProperty("__dynamicallyInstrumented")
}

export function isObservable<T>(v: any): v is RxImported.Observable<T> {
  return typeof v === "object" && v !== null && typeof v.subscribe === "function"
}
export function isSubscription(v: any): v is RxImported.Subscription & any {
  return typeof v === "object" && v instanceof InstrumentedRx.Subscriber
}
export function isObserver(v: any): v is RxImported.Subscription & any {
  return typeof v === "object" && v instanceof InstrumentedRx.Subscriber
}
export function isScheduler(v: any): v is IScheduler & any {
  return typeof v === "object" && v !== null && typeof v.now === "function" && typeof v.schedule === "function"
}
