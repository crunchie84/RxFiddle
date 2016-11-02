import Instrumentation, { defaultSubjects } from "./collector/instrumentation"
import Collector from "./collector/logger"
import { Visualizer } from "./collector/visualizer"
import { VNode, makeDOMDriver } from "@cycle/dom"
import { DOMSource } from "@cycle/dom/rx-typings"
import Cycle from "@cycle/rx-run"
import * as Immutable from "immutable"
import * as Rx from "rx"
import RxMarbles from "rxmarbles"

const Observable = Rx.Observable

let collector = new Collector()
let instrumentation = new Instrumentation(defaultSubjects, collector)
instrumentation.setup()
let vis = new Visualizer(instrumentation.logger, document.getElementById("graph"))
vis.step();
(<any>window).collector = collector;
(<any>window).Rx = Rx

//      /\    
//     /  \   
//    / /\ \  
//   / ____ \ 
//  /_/    \_\

function a() {
  Rx.Observable.of(1, 2, 3)
    .flatMap(i => Rx.Observable.empty())
    .subscribe()
}

//  ____  
// |  _ \ 
// | |_) |
// |  _ < 
// | |_) |
// |____/ 

// Rx.Observable.create(subscriber => {
//   subscriber.onNext("hi!")
//   subscriber.onNext("boo")
//   subscriber.onCompleted()
// })

function b() {
  var A = Rx.Observable.of(1, 2, 3)
    .map(i => "Hello " + i)
    .filter(_ => true)
    .map(_ => _)
    .skip(1)
    .share()
  var B = Rx.Observable.never()

  A.flatMapLatest(s => Rx.Observable.of("bla").startWith(s))
    .groupBy(s => s[s.length - 1])
    .map(o => o.startWith("group of " + o.key))
    .mergeAll()
    .subscribe(console.log)

  A.map(a => a.split("").reverse().join(""))
    .merge(B)
    .filter(a => true)
    .subscribe(console.log)
}

//    _____ 
//   / ____|
//  | |     
//  | |     
//  | |____ 
//   \_____|

function c() {
  // Setup
  RxMarbles.AddCollectionOperator(undefined)
  RxMarbles.AddCollectionOperator(Rx)

  interface ISources {
    DOM: DOMSource
  }

  interface ISinks {
    DOM: Rx.Observable<VNode>
  }
  function main(sources: ISources): ISinks {
    let data = Immutable.fromJS({
      end: 100,
      notifications: [{
        content: "A",
        diagramId: 0,
        id: 1,
        time: 10,
      }],
    })
    const diagram = RxMarbles.DiagramComponent({
      DOM: sources.DOM, props: {
        class: "diagram",
        data: Observable.of(data, data, data),
        interactive: Observable.of(true, true, true, true),
        key: `diagram0`,
      }
    })

    return {
      DOM: diagram.DOM,
    }
  }
  Cycle.run(main, {
    DOM: makeDOMDriver("#app"),
  })
}

function run(m: Function) {
  m()
}


document.getElementById("a").onclick = run.bind(null, a)
document.getElementById("b").onclick = run.bind(null, b)
document.getElementById("c").onclick = run.bind(null, c)
