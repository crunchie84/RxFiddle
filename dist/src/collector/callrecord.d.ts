import { StackFrame } from "../utils";
import { Visualizer } from "./visualizer";
export declare type ICallRecord = ICallStart & ICallEnd;
export interface ICallStart {
    id: number | string | null;
    subject: any;
    subjectName: string;
    method: string;
    arguments: IArguments;
    stack?: StackFrame | string;
    time: number;
    parent?: ICallStart;
    childs: (ICallRecord | ICallStart)[];
    visualizer?: Visualizer;
}
export interface ICallEnd {
    returned: any | null;
}
export declare function callRecordType(record: ICallStart): "setup" | "subscribe" | "event";