import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { installNativeGestures } from "./lib/native-gestures";

const target = document.getElementById("app");
if (target === null) throw new Error("#app missing");

// Before the first paint, so the very first double tap is already cancelled: a WKWebView's own
// double-tap zoom and pinch are what make the app feel like a page in Safari.
installNativeGestures(document);

export default mount(App, { target });
