import JsonCollector from "./collector/jsonCollector"
import RxRunner from "./collector/runner"
import CodeEditor from "./ui/codeEditor"
import { hbox, vbox } from "./ui/flex"
import Resizer from "./ui/resizer"
import { LanguageMenu, errorHandler, shareButton } from "./ui/shared"
import Splash from "./ui/splash"
import Visualizer, { DataSource } from "./visualization"
import { GrapherAdvanced as Grapher } from "./visualization/grapher"
import MorphModule from "./visualization/morph"
import TabIndexModule from "./visualization/tabIndexQuickDirty"
import * as Rx from "rx"
import { init as snabbdom_init } from "snabbdom"
import h from "snabbdom/h"
import attrs_module from "snabbdom/modules/attributes"
import class_module from "snabbdom/modules/class"
import event_module from "snabbdom/modules/eventlisteners"
import style_module from "snabbdom/modules/style"
import { VNode } from "snabbdom/vnode"

const patch = snabbdom_init([class_module, attrs_module, style_module, event_module, MorphModule, TabIndexModule])

const Query$ = Rx.Observable
  .fromEvent(window, "hashchange", () => window.location.hash.substr(1))
  .startWith(window.location.hash.substr(1))
  .map(queryString => {
    return queryString.split("&").map(p => p.split("=")).reduce((p: any, n: string[]) => {
      if (n[0].endsWith("[]")) {
        let key = n[0].substr(0, n[0].length - 1)
        p[key] = p[key] || []
        p[key].push(n[1])
      } else {
        p[n[0]] = n[1]
      }
      return p
    }, {}) || {}
  })

const DataSource$: Rx.Observable<{
  data: DataSource,
  vnode?: Rx.Observable<VNode>,
  runner?: RxRunner,
  editor?: CodeEditor,
}> = Query$.map(q => {
  if (q.type === "demo" && q.source) {
    let collector = new JsonCollector()
    collector.restart(q.source)
    return { data: collector }
  } else if (q.type === "ws" && q.url) {
    let collector = new JsonCollector()
    collector.restart(q.url)
    return { data: collector }
  } else if (q.type === "editor") {
    let editor = new CodeEditor(q.code ? atob(decodeURI(q.code)) : undefined)
    let code = Rx.Observable.fromEventPattern<string>(h => editor.withValue(h as any), h => void (0))
    let runner = new RxRunner(code)
    return {
      data: runner,
      runner,
      editor,
      vnode: editor.dom,
    }
  } else {
    return null
  }
})

function menu(language: VNode, runner?: RxRunner, editor?: CodeEditor): VNode {
  return h("div.left.ml3.flex", { attrs: { id: "menu" } }, [
    language,
    ...(runner ? [h("button.btn", { on: { click: () => runner.trigger() } }, runner.action)] : []),
    ...(editor ? [shareButton(editor)] : []),
  ])
}

const LanguageMenu$ = new LanguageMenu().stream()
const VNodes$: Rx.Observable<VNode[]> = DataSource$.flatMapLatest(collector => {
  if (collector) {
    let vis = new Visualizer(new Grapher(collector.data), document.querySelector("app") as HTMLElement)
    return vis
      .stream()
      .startWith({ dom: h("span.rxfiddle-waiting", "Waiting for Rx activity..."), timeSlider: h("div") })
      .catch(errorHandler)
      .retry()
      .combineLatest(
      collector.vnode || Rx.Observable.just(undefined),
      LanguageMenu$.dom,
      collector.runner && collector.runner.state || Rx.Observable.just(undefined),
      (render, input, langs, state) => [
        h("div#menufold-static.menufold", [
          h("a.brand.left", { attrs: { href: "#" } }, [
            h("img", { attrs: { alt: "ReactiveX", src: "RxIconXs.png" } }),
            "RxFiddle" as any as VNode,
          ]),
          menu(langs, collector.runner, collector.editor),
        ]),
        // h("div#menufold-fixed.menufold"),
        hbox(...(input ?
          [Resizer.h("rxfiddle/editor+rxfiddle/inspector", input, vbox(render.timeSlider, render.dom))] :
          [vbox(render.timeSlider, render.dom)]
        )),
      ])
  } else {
    return new Splash().stream().map(n => [h("div.flexy", [n])])
  }
})

let app = document.querySelector("body") as VNode | HTMLBodyElement
VNodes$.subscribe(vnodes => {
  try {
    app = patch(app, h("body#", { tabIndexRoot: true }, vnodes))
  } catch (e) {
    console.error("Error in snabbdom patching; restoring. Next patch will be handled clean.", e)
    app = document.querySelector("body")
  }
})
