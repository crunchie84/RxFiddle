import Logger from "../app/src/collector/logger"
import { TreeCollector } from "../app/src/instrumentation/rxjs-5.x.x/collector"
import Instrumentation from "../app/src/instrumentation/rxjs-5.x.x/instrumentation"
import * as WebSocket from "ws"

// Unused, but will support multi-version instrumention in the future maybe
// interface RxFiddleOptions {
//   version?: 4 | 5 // default "detects"
//   targets?: any[] // default "all available"
//   serve?: { port: number, networkInterface?: string } // default off
// }

export type TeardownLogic = Function
export type OnNext = (m: any) => void
export type PartialObserver = OnNext | { next: OnNext } | { onNext: OnNext }

export default class RxFiddle {

  constructor(private targets: { [name: string]: any } = {}) {
    if("Rx" in targets) {
      Object.assign(targets, {
        Observable: targets.Rx.Observable,
        Subscriber: targets.Rx.Subscriber,
      })
    }
    Object.keys(targets).forEach(name => {
      if(
        (name === "Observable" || name === "Subscriber") &&
        Object.keys(targets).map(name => targets[name]).indexOf(targets[name].prototype) < 0
      ) {
        targets[name + "Proto"] = targets[name].prototype
      }
    })
    this.targets = targets
  }

  /**
   * Setup instrumentation and forward all messages to the provided Observer
   * @param observer 
   */
  public subscribe(observer: PartialObserver): TeardownLogic {
    let next: OnNext = typeof observer === "function" ? observer : () => { /* */ }
    if (typeof observer === "object") {
      next = ((observer as any).next || (observer as any).onNext).bind(observer)
    }
    let logger = new Logger(m => next(m))
    return this.instrumentRx5(logger)
  }

  /**
   * Setup instrumentation and a WebSocketServer and publish all messages there
   * @param param Specify a port
   */
  public serve({ port }: { port: number, networkInterface?: string }): TeardownLogic {
    let replayQueue = [] as any[]
    let wss = new WebSocket.Server({ perMessageDeflate: false, port })
    console.log(`RxFiddle server is serving at port ${port}. Surf to https://rxfiddle.net/#type=ws&url=ws://127.0.0.1:${port}.`)

    let first = true

    // Subscribe and send to all clients
    let teardown = this.subscribe((m: any) => {
      if(first) {
        console.log("RxFiddle detected Observables and now publishes the data.")
        first = false
      }
      let json = JSON.stringify(m)
      wss.clients.forEach(ws => ws.send(json))
      replayQueue.push(json)
    })

    // Replay for new connections
    wss.on("connection", (ws) => {
      console.log("RxFiddle client connected.")
      ws.send(`{ "version": "1.0.0" }`)
      replayQueue.forEach(m => ws.send(m))
    })

    // Cleanup
    return () => {
      teardown()
      wss.close((err) => console.warn("Error while closing RxFiddle WebSocket server.", err))
    }
  }

  private instrumentRx5(logger: Logger): TeardownLogic {
    // Attach intrumentation
    let instrumentation = new Instrumentation(new TreeCollector(logger))
    instrumentation.setup()
    Object.keys(this.targets).forEach(name =>
      instrumentation.setup(this.targets[name], name)
    )
    return instrumentation.teardown
  }

}
