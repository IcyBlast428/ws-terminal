'use strict';

const recent = [];
let nodeName = '';
function configure(node) { nodeName = node; }
function log(event, fields = {}) {
  const entry = {
    time: new Date().toISOString(),
    event,
    node: nodeName,
    ...fields
  };
  recent.push(entry);
  if (recent.length > 200) recent.shift();
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function error(event, err, fields = {}) {
  log(event, {
    ...fields,
    error: err instanceof Error ? err.message : String(err)
  });
}

module.exports = {
  error,
  configure,
  recent: () => [...recent],
  log
};
