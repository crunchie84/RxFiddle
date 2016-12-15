"use strict";
require("../utils");
const graphlib_1 = require("graphlib");
const _ = require("lodash");
const TRACE = false;
function trace(...args) {
    if (TRACE)
        console.log.apply(console, arguments);
}
function last(list) {
    return list[list.length - 1];
}
function head(list) {
    return list[0];
}
function takeWhile(list, pred) {
    let ret = [];
    for (let i = 0; i < list.length && pred(list[i]); i++) {
        ret.push(list[i]);
    }
    return ret;
}
function range(start, exclusiveEnd) {
    let r = [];
    for (let i = start; i < exclusiveEnd; i++) {
        r.push(i);
    }
    return r;
}
function avg(list) {
    if (list.length === 0)
        return undefined;
    if (list.length === 1)
        return list[0];
    return list.reduce((sum, v) => sum + (v / list.length), 0);
}
function absMin(a, b) {
    return Math.abs(a) < Math.abs(b) ? a : b;
}
function clone(g, edgeFilter, transform) {
    let clone = new graphlib_1.Graph({
        multigraph: g.isMultigraph(),
        directed: g.isDirected(),
        compound: g.isCompound(),
    });
    let edges = typeof edgeFilter === "undefined" ?
        g.edges() :
        g.edges().filter(edgeFilter);
    function add(e) {
        clone.setEdge(e.v, e.w, g.edge(e.v, e.w));
    }
    edges.forEach(e => {
        if (typeof transform === "undefined") {
            add(e);
        }
        else {
            transform(e).forEach(add);
        }
    });
    return clone;
}
exports.clone = clone;
function firstDefined(...args) {
    if (typeof args[0] !== "undefined") {
        return args[0];
    }
    if (args.length > 1) {
        return firstDefined(...args.slice(1));
    }
    return undefined;
}
function sort(input, byRefIndex) {
    return input.map((item, index) => ({ item, index, refIndex: byRefIndex(item) }))
        .sort((a, b) => {
        if (typeof a.refIndex !== "undefined" && typeof b.refIndex !== "undefined") {
            return a.refIndex - b.refIndex;
        }
        else {
            return firstDefined(a.refIndex, a.index) - firstDefined(b.refIndex, b.index);
        }
    }).map(v => v.item);
}
function sweep(input, direction, sort) {
    trace("Sweeping", direction);
    if (direction === "down") {
        for (let i = 1, ref = i - 1; i < input.length; i++, ref++) {
            input[i] = sort(input[i], input[ref]);
        }
    }
    else {
        for (let i = input.length - 2, ref = i + 1; i >= 0; i--, ref--) {
            input[i] = sort(input[i], input[ref]);
        }
    }
    return input;
}
/**
 * @see https://github.com/cpettitt/dagre/blob/master/lib/rank/util.js
 */
function rankLongestPath(g) {
    let visited = {};
    let ranks = {};
    function dfs(v) {
        if (_.has(visited, v)) {
            return ranks[v];
        }
        visited[v] = true;
        let rank = _.min(_.map(g.outEdges(v), (e) => {
            return dfs(e.w) - (g.edge(e).minlen || 1);
        }));
        if (rank === Number.POSITIVE_INFINITY || typeof rank === "undefined") {
            rank = 0;
        }
        return (ranks[v] = rank);
    }
    _.each(g.sources(), dfs);
    return ranks;
}
exports.rankLongestPath = rankLongestPath;
function leftPad(l, a) {
    let r = `${a}`;
    while (r.length < l) {
        r = " " + r;
    }
    return r;
}
function rightPad(l, a) {
    let r = `${a}`;
    while (r.length < l) {
        r += " ";
    }
    return r;
}
const ENABLE_NORMALIZE = true;
const ENABLE_BARYCENTRESORT = true;
const ENABLE_PRIORITYLAYOUT = true;
// TODO make it online
function structureLayout(g) {
    let ranks = rankLongestPath(g);
    trace("ranks\n", ranks);
    // Without long edges
    let normalized;
    if (ENABLE_NORMALIZE) {
        normalized = clone(g, undefined, e => {
            if (ranks[e.v] + 1 < ranks[e.w]) {
                // Add dummy nodes + edges
                let dummies = range(ranks[e.v] + 1, ranks[e.w]).map(i => ({ label: `dummy-${e.v}-${e.w}(${i})`, rank: i }));
                dummies.forEach(d => ranks[d.label] = d.rank);
                let nodes = [e.v].concat(dummies.map(d => d.label)).concat([e.w]);
                return nodes.slice(1).map((w, i) => ({ v: nodes[i], w }));
            }
            else {
                return [e];
            }
        });
    }
    else {
        normalized = g;
    }
    let byRank = groupByUniq(node => ranks[node], Object.keys(ranks));
    // Convert rank's vertices to layered layout items
    let layers = Object.keys(byRank).sort((a, b) => +a - +b).map((r, y) => {
        return byRank[r].map((n, x) => ({
            node: n,
            x,
            y,
            isDummy: n.startsWith("dummy"),
            barycenter: 0,
            priority: 0,
        }));
    });
    // Sort vertices according to BaryCenter's
    if (ENABLE_BARYCENTRESORT) {
        for (let iteration = 0; iteration < 10; iteration++) {
            let direction = iteration % 2 === 0 ? "down" : "up";
            sweep(layers, "down", (subject, ref) => {
                return sort(subject, (item) => {
                    return barycenter(normalized, direction, item.node, linked => ref.findIndex(r => r.node === linked));
                });
            });
            layers.reverse();
        }
        layers.forEach(layer => layer.forEach((item, index) => item.x = index));
    }
    // Balancing or centering relative to branches
    if (ENABLE_PRIORITYLAYOUT) {
        for (let iteration = 0; iteration < 2; iteration++) {
            let direction = iteration % 2 === 0 ? "down" : "up";
            sweep(layers, direction, (subject, ref) => {
                subject.forEach(item => {
                    item.priority = item.isDummy ? Number.MAX_SAFE_INTEGER : priority(normalized, direction, item.node);
                    item.barycenter = barycenter(normalized, direction, item.node, linked => head(ref.filter(r => r.node === linked).map(r => r.x)));
                });
                priorityLayoutReorder(subject);
                return subject;
            });
        }
        shiftOffset(layers);
    }
    let layout = layers.flatMap(v => v);
    return {
        layout,
        graph: normalized,
    };
}
exports.structureLayout = structureLayout;
function linkedNodes(g, direction, node) {
    return direction === "down" ?
        g.inEdges(node).map(e => e.v) :
        g.outEdges(node).map(e => e.w);
}
function barycenter(g, direction, node, ref) {
    let nodes = linkedNodes(g, direction, node);
    // Find Barycenter
    let positions = nodes.map(ref).filter(v => typeof v === "number");
    return avg(positions);
}
function priority(g, direction, node) {
    let nodes = linkedNodes(g, direction, node);
    return nodes.length;
}
function priorityLayoutReorder(items) {
    let move = (priority, index, requestedShift) => {
        let subject = items[index];
        if (subject.priority > priority || requestedShift === 0)
            return 0;
        if (items.length === index + 1 && requestedShift > 0) {
            subject.x += requestedShift;
            return requestedShift;
        }
        if (index === 0 && requestedShift < 0) {
            subject.x += requestedShift;
            return requestedShift;
        }
        let next = index + Math.sign(requestedShift);
        let slack = absMin(requestedShift, items[next].x - subject.x - Math.sign(requestedShift));
        // Bubble move
        let nextMoved = move(priority, next, requestedShift - slack);
        subject.x += slack + nextMoved;
        return slack + nextMoved;
    };
    items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => b.item.priority - a.item.priority)
        .forEach(({ item, index }) => {
        if (typeof item.barycenter !== "undefined") {
            move(item.priority, index, Math.round(item.barycenter) - item.x);
        }
    });
}
exports.priorityLayoutReorder = priorityLayoutReorder;
function shiftOffset(layers) {
    let max = Number.MAX_SAFE_INTEGER;
    let offset = layers.reduce((l, layer) => Math.min(l, layer.reduce((p, item) => Math.min(p, item.x), max)), max);
    layers.forEach(layer => layer.forEach(item => {
        item.x -= offset;
    }));
}
function lines(g) {
    let ranks = rankLongestPath(g);
    let grouped = _.mapValues(_.groupBy(_.toPairs(ranks), l => l[1]), v => v.map(n => n[0]));
    let groups = _.toPairs(grouped);
    let levels = groups
        .sort((a, b) => a[0] - b[0]);
    trace(levels.map(l => `${leftPad(5, l[0])}${l[1].map(leftPad.bind(null, 5)).join("")}`).join("\n"));
    let visited = {};
    let positions = {};
    function dfs(v, index = 0) {
        if (_.has(visited, v)) {
            return positions[v];
        }
        visited[v] = true;
        let rank = _.max(_.map(g.outEdges(v), (e, i) => { return dfs(e.w, i + index); }));
        if (rank === Number.POSITIVE_INFINITY || typeof rank === "undefined") {
            rank = index;
        }
        return (positions[v] = rank);
    }
    _.each(g.sources(), dfs);
    trace(positions);
    let ls = levels.map(l => {
        let row = l[1].reduce((text, n) => {
            let p = positions[n];
            text = rightPad(p * 4 + 4, text);
            return text.substr(0, p * 4) + leftPad(4, n) + text.substr((p + 1) * 4, text.length);
        }, "");
        return `${leftPad(5, l[0])}${row}`;
    }).join("\n");
    trace(ls);
    return [];
}
exports.lines = lines;
function indexedBy(selector, list) {
    let obj = {};
    list.forEach((i) => { obj[selector(i)] = i; });
    return obj;
}
exports.indexedBy = indexedBy;
function groupBy(selector, list) {
    let obj = {};
    list.forEach((i) => {
        let k = selector(i);
        obj[k] = obj[k] || [];
        obj[k].push(i);
    });
    return obj;
}
exports.groupBy = groupBy;
function groupByUniq(selector, list) {
    let obj = {};
    list.forEach((i) => {
        let k = selector(i);
        obj[k] = obj[k] || [];
        if (obj[k].indexOf(i) === -1) {
            obj[k].push(i);
        }
    });
    return obj;
}
exports.groupByUniq = groupByUniq;
//# sourceMappingURL=graphutils.js.map