/* TVsham website: the safety net. index.html loads this before the app's bundle, and it depends on
   nothing, so that when the bundle fails to load, throws while starting, or meets a browser too old
   for it, the visitor reads a short note instead of an empty page or controls that do nothing.
   A file of its own because the Content-Security-Policy runs no inline script. */
(function () {
  "use strict";

  var html = document.documentElement;
  // index.html starts with class="no-js"; scripts are running, so take it off.
  html.classList.remove("no-js");

  // What the app needs from the browser that a bundle cannot polyfill for itself: every request it
  // makes carries a deadline built with AbortSignal.timeout (Chrome 103, Safari 16, Firefox 100).
  var modern =
    typeof Promise !== "undefined" &&
    typeof Promise.prototype.finally === "function" &&
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function" &&
    typeof FormData !== "undefined";

  function root() {
    return document.getElementById("root");
  }
  function drawn() {
    var r = root();
    return !!(r && r.firstChild);
  }
  function fail() {
    html.classList.add("startup-failed");
  }

  if (!modern) fail();

  // Capture phase: a script that fails to load fires an error that does not bubble.
  window.addEventListener(
    "error",
    function (e) {
      var el = e.target;
      if (el && el !== window && el.tagName) {
        if (el.tagName.toLowerCase() === "script") fail();
        return; // an image that did not load is the app's own business
      }
      if (!drawn()) fail();
    },
    true,
  );
  window.addEventListener("unhandledrejection", function () {
    if (!drawn()) fail();
  });

  // The bundle is deferred, so by the load event it has run. A moment later the app has drawn, or
  // it is not going to. The note stands aside again if the app draws after all: a slow phone is
  // not a failure, and the note must never sit on top of a working app.
  window.addEventListener("load", function () {
    var r = root();
    if (r && typeof MutationObserver === "function") {
      new MutationObserver(function () {
        if (drawn() && modern) html.classList.remove("startup-failed");
      }).observe(r, { childList: true });
    }
    setTimeout(function () {
      if (!drawn()) fail();
    }, 3000);
  });
})();
