// Incremental Server-Sent Events parser. Feed it text chunks; it calls
// onEvent(eventName, data) for each complete event.
function createSseParser(onEvent) {
  let buffer = '';
  return function push(text) {
    buffer += text;
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
  };
}

module.exports = { createSseParser };
