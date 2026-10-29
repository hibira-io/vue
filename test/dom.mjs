// Gives node a DOM for mounting components.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const name of ['Element', 'SVGElement', 'HTMLElement', 'Node', 'navigator']) globalThis[name] ??= dom.window[name];
