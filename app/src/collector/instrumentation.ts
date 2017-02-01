import "../utils"
import { ICallRecord, ICallStart, ICallEnd } from "./callrecord"
import { ICollector } from "./logger"
import { RxCollector } from "./visualizer"
import * as Rx from "rx"

const rxAny: any = <any>Rx

export let defaultSubjects = {
  Observable: Rx.Observable,
  "Observable.prototype": rxAny.Observable.prototype,
  "ConnectableObservable.prototype": rxAny.ConnectableObservable.prototype,
  "ObservableBase.prototype": rxAny.ObservableBase.prototype,
  "AbstractObserver.prototype": rxAny.internals.AbstractObserver.prototype,
  "AnonymousObserver.prototype": rxAny.AnonymousObserver.prototype,
  "Subject.prototype": rxAny.Subject.prototype,
}

export const HASH = "__hash"
export const IGNORE = "__ignore"

function now() {
  return typeof performance !== "undefined" ? performance.now() : new Date().getTime()
}

/* tslint:disable:interface-name */
export interface Function {
  caller?: Function
  __originalFunction?: Function | null
  apply(subject: any, args: any[] | IArguments): any
}

function hasRxPrototype(input: any): boolean {
  return typeof input === "object" && (
    rxAny.Observable.prototype.isPrototypeOf(input) ||
    rxAny.internals.AbstractObserver.prototype.isPrototypeOf(input)
  )
}

function startsWith(input: string, matcher: string) {

  let r = input.substr(0, matcher.length) === matcher
  return r
}

function detachedScopeProxy<T>(input: T): T {
  let hashes: { [id: string]: number } = {}
  if ((<any>input).__detached === true) {
    return input
  }
  return new Proxy(input, {
    get: (target: any, property: PropertyKey): any => {
      if (property === "__detached") {
        return true
      }
      if (typeof property === "string" && startsWith(property, "__hash")) {
        return hashes[property]
      }
      return (<any>target)[property]
    },
    set: (target, property, value): boolean => {
      if (typeof property === "string" && startsWith(property, "__hash")) {
        hashes[property] = value
      }
      return true
    },
  })
}

/**
 * Tweaks specific for RxJS 4
 */
function rxTweaks<T>(call: ICallStart): void {
  // Detach reuse of NeverObservable
  let fields: [any, PropertyKey][] = []
  fields.push([call, "subject"], [call, "returned"])
  fields.push(...[].map.call(call.arguments, (a: any, i: number) => [call.arguments, i]))
  fields.forEach(([subject, prop]) => {
    if (
      typeof subject[prop] !== "undefined" && subject[prop] !== null &&
      subject[prop].constructor.name === "NeverObservable"
    ) {
      subject[prop] = detachedScopeProxy(subject[prop])
    }
  })
  // Other tweaks here...
}

let i = 0

export default class Instrumentation {
  public logger: RxCollector
  public open: any[] = []
  public stackTraces: boolean = true

  private subjects: { [name: string]: any; }
  private calls: (ICallStart | ICallRecord)[] = []

  private prototypes: any[] = []

  constructor(subjects: { [name: string]: any; } = defaultSubjects, logger: RxCollector) {
    this.subjects = subjects
    this.logger = logger
    Object.keys(subjects).slice(0, 1).forEach((s: string) => subjects[s][IGNORE] = true)
  }

  /* tslint:disable:only-arrow-functions */
  /* tslint:disable:no-string-literal */
  /* tslint:disable:no-string-literal */
  public instrument(fn: Function, extras: { [key: string]: string; }): Function {
    let calls = this.calls
    let logger = this.logger
    let open = this.open
    let self = this

    let instrumented = new Proxy(fn, {
      apply: (target: any, thisArg: any, argumentsList: any[]) => {
        // console.log(target.caller)

        // find more
        argumentsList
          .filter(hasRxPrototype)
          .filter((v: any) => !v.hasOwnProperty("__instrumented"))
          .forEach((t: any) => this.setupPrototype(t))

        let call: ICallStart = {
          arguments: [].slice.call(argumentsList, 0),
          childs: [],
          id: i++,
          method: extras["methodName"],
          stack: self.stackTraces ? new Error().stack : undefined,
          subject: thisArg,
          subjectName: extras["subjectName"],
          time: now(),
        }

        // Prepare
        calls.push(call)
        if (open.length > 0) {
          call.parent = open[open.length - 1]
          call.parent.childs.push(call)
        }
        open.push(call)

        // Nicen up Rx performance tweaks
        rxTweaks(call)

        // Actual method
        let instanceLogger = logger.before(call, open.slice(0, -1))
        let returned = target.apply(call.subject, [].map.call(
          argumentsList,
          instanceLogger.wrapHigherOrder.bind(instanceLogger, call.subject))
        )

        let end: ICallRecord = call as ICallRecord
        end.returned = returned

        // Nicen up Rx performance tweaks
        rxTweaks(end)

        instanceLogger.after(end)

        // find more
        new Array(end.returned)
          .filter(hasRxPrototype)
          .filter((v: any) => !v.hasOwnProperty("__instrumented"))
          .forEach((t: any) => this.setupPrototype(t))

        // Cleanup
        open.pop()
        return end.returned
      },
      construct: (target: { new (...args: any[]): any }, args) => {
        console.warn("TODO, instrument constructor", target, args)
        return new target(...args)
      },
    })
    instrumented.__originalFunction = fn
    return instrumented
  }

  public deinstrument(fn: Function) {
    return fn.__originalFunction || fn
  }
  /* tslint:enable:only-arrow-functions */
  /* tslint:enable:no-string-literal */
  /* tslint:enable:no-string-literal */

  public setup(): void {
    Object.keys(this.subjects)
      .forEach(name => this.setupPrototype(this.subjects[name], name))
    rxAny.Subject = this.instrument(rxAny.Subject, {
      methodName: "new",
      subjectName: "Rx.Subject",
    })
  }

  public setupPrototype(prototype: any, name?: string) {
    if (typeof name !== "undefined") {
      prototype.__dynamicallyInstrumented = true
    }
    let methods = Object.keys(prototype)
      .filter((key) => typeof prototype[key] === "function")

    // log, preparing for teardown
    this.prototypes.push(prototype)

    methods.forEach(key => {
      prototype[key].__instrumented = true
      prototype[key] = this.instrument(prototype[key], {
        methodName: key,
        subjectName: name || prototype.constructor.name,
      })
    })
  }

  public teardown(): void {
    rxAny.Subject = this.deinstrument(rxAny.Subject)

    let properties: { key: string, subject: any }[] = this.prototypes
      .map(subject => Object.keys(subject).map(key => ({ key, subject })))
      .reduce((prev, next) => prev.concat(next), [])

    let methods = properties
      .filter(({ key, subject }) => typeof subject[key] === "function")

    methods.forEach(({ key, subject }) => {
      subject[key] = this.deinstrument(subject[key])
      delete subject.__instrumented
    })
  }
}