import {createApp} from './server.js';

// Vercel invokes this exported Express application per request. Persistent server
// listeners are started only by server.ts in local/hosted Node process mode.
export default createApp();
