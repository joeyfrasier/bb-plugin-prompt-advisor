import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "CustomEvent",
  "MutationObserver",
] as const)
  Object.defineProperty(globalThis, name, {
    value: dom.window[name],
    configurable: true,
  });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  writable: true,
  configurable: true,
});
