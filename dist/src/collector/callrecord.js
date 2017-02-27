"use strict";
function callRecordType(record) {
    if (record.subjectName === "Observable" ||
        record.subjectName === "Observable.prototype" ||
        record.subjectName === "ObservableBase.prototype" ||
        record.subjectName.indexOf("Observable") >= 0) {
        if (record.method === "subscribe" || record.method === "_subscribe" || record.method === "__subscribe") {
            return "subscribe";
        }
        return "setup";
    }
    else {
        return "event";
    }
}
exports.callRecordType = callRecordType;
//# sourceMappingURL=callrecord.js.map