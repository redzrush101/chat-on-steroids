/** Retained debugger observations and their bounded public projections. */
export function createBrowserObservations({ send, cut, error }) {
  // Observation buffers have their own owner. The tab custodian only carries this
  // opaque record alongside its navigation and attachment state.
  function createState() {
    return { console: [], network: new Map(), seq: 0, consoleDropped: 0, networkDropped: 0 };
  }

  const headers = value => {
    const result = {}; let size = 0;
    for (const [key,val] of Object.entries(value || {}).slice(0,50)) {
      if (/authorization|cookie|token|api.?key/i.test(key)) { result[key] = '[redacted]'; continue; }
      const text = cut(val,1000); size += key.length+text.length;
      if (size > 6000) break; result[cut(key,100)] = text;
    }
    return result;
  };

  function recordConsole(state, pageId, params) {
    const data = params.exceptionDetails || params.entry || params;
    let level = params.exceptionDetails ? 'error' : data.level || data.type || 'info';
    level = ({warn:'warning',log:'info',verbose:'debug'})[level] || level;
    const message = params.args ? params.args.slice(0,10).map(a => cut(a.value ?? a.description ?? a.type,1200)).join(' ') : cut(data.exception?.description || data.text,2500);
    state.console.push({seq:++state.seq,pageId,level,message:cut(message,3000),url:cut(data.url,1000),timestamp:Date.now()});
    if (state.console.length > 200) { state.console.shift(); state.consoleDropped++; }
  }

  function recordNetwork(state, pageId, source, method, params) {
    const key = `${source.sessionId || 'main'}:${params.requestId}`;
    let row = state.network.get(key);
    if (method === 'Network.requestWillBeSent') {
      row = {requestId:key,nativeId:params.requestId,sessionId:source.sessionId,pageId,url:cut(params.request?.url,2000),method:cut(params.request?.method,20),type:cut(params.type,30),requestHeaders:headers(params.request?.headers),postData:cut(params.request?.postData,4000),startedAt:params.timestamp,seq:++state.seq};
      state.network.set(key,row);
      if (state.network.size > 200) {state.network.delete(state.network.keys().next().value);state.networkDropped++;}
    } else if (row) {
      row.seq = ++state.seq;
      if (method === 'Network.responseReceived') Object.assign(row,{status:params.response?.status,mimeType:cut(params.response?.mimeType,100),responseHeaders:headers(params.response?.headers),fromCache:params.response?.fromDiskCache === true});
      if (method === 'Network.loadingFinished') Object.assign(row,{finished:true,encodedBytes:params.encodedDataLength,durationMs:Math.round((params.timestamp-row.startedAt)*1000)});
      if (method === 'Network.loadingFailed') Object.assign(row,{failed:cut(params.errorText,1000),finished:true});
    }
  }

  async function diagnostics(tab,tool,args) {
    const state = tab.observations;
    const network = tool === 'browser_network';
    if (network && args.requestId) {
      const row = state.network.get(args.requestId);
      if (!row) error('BROWSER_REQUEST_EXPIRED: request is not in the retained buffer.');
      let body;
      if (args.body) {
        if (row.encodedBytes > 500000) body = { unavailable:'Response exceeds the 500 KB capture limit.' };
        else try {
          const data = await send(tab,'Network.getResponseBody',{requestId:row.nativeId},row.sessionId);
          body = { text:cut(data.body,20000),base64Encoded:data.base64Encoded === true,truncated:data.body.length > 20000 };
        } catch { body = { unavailable:'Chrome no longer retains this response body, or it has not completed.' }; }
      }
      const { nativeId:_native,sessionId:_session,...value } = row;
      return { ...value,...(body ? {body}: {}) };
    }
    const rows = network ? [...state.network.values()] : state.console;
    const matching = rows.filter(row => row.seq > (args.after || 0) &&
      (!args.filter || JSON.stringify(row).toLowerCase().includes(args.filter.toLowerCase())) &&
      (network || !args.level || args.level === 'all' || row.level === args.level)).sort((a,b) => a.seq-b.seq);
    const selected = matching.slice(0,args.limit || 50);
    const values = []; let size = 0;
    for (const row of selected) {
      const { nativeId:_native,sessionId:_session,requestHeaders:_rq,responseHeaders:_rs,postData:_post,...brief } = row;
      const value = network ? brief : row;
      size += JSON.stringify(value).length;
      if (size > 24000) break;
      values.push(value);
    }
    if (args.clear) { if (network) state.network.clear(); else state.console = []; }
    return { entries:values,nextCursor:values.at(-1)?.seq || args.after || 0,truncated:values.length < matching.length,dropped:network ? state.networkDropped : state.consoleDropped,capture:'Since debugger attachment; older events are unavailable.' };
  }

  return { createState, recordConsole, recordNetwork, diagnostics };
}
