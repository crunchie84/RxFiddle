import Instrumentation, { defaultSubjects } from "./collector/instrumentation"
import Collector from "./collector/logger"
import Visualizer, { Grapher } from "./visualization"
import { VNode, makeDOMDriver } from "@cycle/dom"
import { DOMSource } from "@cycle/dom/rx-typings"
import Cycle from "@cycle/rx-run"
import * as Immutable from "immutable"
import * as Rx from "rx"
import RxMarbles from "rxmarbles"
import JsonCollector from "./collector/jsonCollector"

const Observable = Rx.Observable;
(window as any).Rx = Rx

let collector = new JsonCollector()
// let collector = new Collector()
// let instrumentation = new Instrumentation(defaultSubjects, collector)
// instrumentation.setup()
let vis = new Visualizer(
  new Grapher(collector),
  document.querySelector("app") as HTMLElement,
  document.getElementById("controls")
)

vis.step();
(window as any).collector = collector;
(window as any).visualizer = vis;

//      /\    
//     /  \   
//    / /\ \  
//   / ____ \ 
//  /_/    \_\

function a() {
  Rx.Observable.of(1, 2, 3)
    .map(s => s)
    .groupBy(v => v)
    .mergeAll()
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
  var A = Rx.Observable.interval(1000)
    .map(i => "Hello " + i)
    .filter(_ => true)
    .map(_ => _)
    .skip(1)
    .publish()
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

  A.connect()
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

function onHashChange() {
  let query = window.location.hash.substr(1).split("&").map(p => p.split("=")).reduce((p: any, n: string[]) => {
    if (n[0].endsWith("[]")) {
      let key = n[0].substr(0, n[0].length - 1)
      p[key] = p[key] || []
      p[key].push(n[1])
    } else {
      p[n[0]] = n[1]
    }
    return p
  }, {}) || {}
  console.log(query)
  if (query.source) {
    collector.restart(query.source)
  }
}

window.addEventListener("hashchange", onHashChange, false)

if (!window.location.hash) {
  window.location.hash = "source=tree_a"
} else {
  onHashChange()
}

// document.getElementById("a").onclick = run.bind(null, a)
// document.getElementById("a").onclick = () => { source = "tree_a.json"; collector.restart(source) }
// document.getElementById("b").onclick = () => { source = "tree_b.json"; collector.restart(source) }
// document.getElementById("c").onclick = () => { source = "tree_c.json"; collector.restart(source) }
// document.getElementById("d").onclick = () => { source = "tree_d.json"; collector.restart(source) }
// document.getElementById("e").onclick = () => { source = "tree_e.json"; collector.restart(source) }
// document.getElementById("f").onclick = () => { source = "tree_f.json"; collector.restart(source) }
// let trace = document.getElementById("trace") as HTMLInputElement
// let ids = document.getElementById("showIds") as HTMLInputElement

// trace.addEventListener("click", () => {
//   // instrumentation.stackTraces = trace.checked
// })

// ids.addEventListener("click", () => {
//   // vis.showIds = ids.checked
// })

c()
