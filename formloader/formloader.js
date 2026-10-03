/*
 * N:N Multi-Select – form loader (web resource kv_/NToNMultiSelect/formloader.js)
 *
 * Optional. Add this web resource as a form library only on forms where the KV.NToNMultiSelect control shows
 * "Error loading control", and register KVNToNMultiSelectLoader.onLoad as an OnLoad handler (tick "Pass execution
 * context as first parameter" and pass the column name(s) of the control as parameters, e.g. 'new_projectskills').
 *
 * Why it exists: some Dataverse environments return code components to the form with an empty resource list, so
 * the platform never downloads the control's bundle.js and reports "Could not find/invoke ... constructor". This
 * library downloads the bundle into the app window as soon as the form starts loading. If the platform delivers the
 * bundle itself, the loader either finds the control already registered or waits for the platform's download
 * instead of fetching a second copy.
 *
 * Everything this file keeps on the app window is named after the control, so loaders of other controls (or an
 * older copy of this one) can never use each other's state.
 */
(function () {
    "use strict";

    var CONTROL = "KV.NToNMultiSelect";
    var BUNDLE = "cc_KV.NToNMultiSelect/bundle.js";
    var VERSION = "__VERSION__";
    var STATE_KEY = "__pcfLoader:" + CONTROL;
    var REMOUNTS_KEY = "__pcfRemounts:" + CONTROL;

    /** Form scripts run in a hidden same-origin iframe; the control host is its parent (the app window). */
    function hostWindow() {
        try {
            if (window.parent && window.parent !== window && window.parent.document) {
                return window.parent;
            }
        } catch (e) {
            // cross-origin parent: fall back to this window
        }
        return window;
    }

    var host = hostWindow();

    function isRegistered() {
        try {
            var cf = host.ComponentFramework;
            if (cf && typeof cf.getRegisteredControl === "function" && typeof cf.getRegisteredControl(CONTROL) === "function") {
                return true;
            }
            return !!(host.KV && typeof host.KV.NToNMultiSelect === "function");
        } catch (e) {
            return false;
        }
    }

    function clientUrl() {
        try {
            return host.Xrm.Utility.getGlobalContext().getClientUrl();
        } catch (e) {
            return host.location.origin;
        }
    }

    /** A script tag for this bundle that is already on the page (added by this loader, or the platform's own). */
    function existingScript(doc) {
        var scripts = doc.getElementsByTagName("script");
        for (var i = 0; i < scripts.length; i++) {
            if ((scripts[i].getAttribute("src") || "").indexOf("/" + BUNDLE) >= 0) {
                return scripts[i];
            }
        }
        return null;
    }

    function load() {
        var existing = host[STATE_KEY];
        if (existing) {
            return existing;
        }
        var promise = new Promise(function (resolve, reject) {
            if (isRegistered()) {
                resolve();
                return;
            }
            var doc = host.document;

            function inject() {
                var script = doc.createElement("script");
                script.setAttribute("data-pcf-loader", CONTROL);
                script.src = clientUrl() + "/webresources/" + BUNDLE + "?v=" + encodeURIComponent(VERSION);
                script.async = true;
                script.onload = function () {
                    if (isRegistered()) {
                        resolve();
                    } else {
                        reject(new Error(CONTROL + " bundle loaded but did not register the control."));
                    }
                };
                script.onerror = function () {
                    reject(new Error("Could not download " + BUNDLE + "."));
                };
                (doc.head || doc.documentElement).appendChild(script);
            }

            var pending = existingScript(doc);
            if (pending && pending.getAttribute("data-pcf-loader") === CONTROL) {
                // An earlier attempt by this loader that failed: replace it with a fresh download.
                pending.parentNode.removeChild(pending);
                pending = null;
            }
            if (!pending) {
                inject();
                return;
            }
            // The platform is already loading the bundle itself: give it up to 10 seconds to register the control,
            // then download a copy after all.
            var waited = 0;
            var timer = host.setInterval(function () {
                waited += 100;
                if (isRegistered()) {
                    host.clearInterval(timer);
                    resolve();
                } else if (waited >= 10000) {
                    host.clearInterval(timer);
                    inject();
                }
            }, 100);
        });
        host[STATE_KEY] = promise;
        promise["catch"](function (error) {
            host[STATE_KEY] = null; // allow a retry on the next form load
            if (host.console) host.console.error("[" + CONTROL + " loader]", error);
        });
        return promise;
    }

    /**
     * A control that tried to start before the bundle arrived shows "Error loading control". Hiding and showing it
     * makes the form create it again, now that the constructor exists. Only visible controls that failed are
     * touched, at most twice per control and record. `onlyNames` are column names; every control bound to one of
     * those columns counts (the header copy, a second copy on another tab).
     */
    function remountFailedControls(formContext, onlyNames) {
        var doc = host.document;
        var failed = doc.querySelectorAll('.customControl.inError[data-id$=".fieldControl_container_error"]');
        var tries = host[REMOUNTS_KEY] || (host[REMOUNTS_KEY] = {});
        for (var i = 0; i < failed.length; i++) {
            var dataId = failed[i].getAttribute("data-id") || "";
            var name = dataId.slice(0, dataId.length - ".fieldControl_container_error".length);
            if (!name || (onlyNames.length && onlyNames.indexOf(name) < 0 && onlyNames.indexOf(columnOf(formContext, name)) < 0)) {
                continue;
            }
            var key = name + "|" + (formContext.data && formContext.data.entity ? formContext.data.entity.getId() : "");
            tries[key] = (tries[key] || 0) + 1;
            if (tries[key] > 2) {
                continue;
            }
            remount(formContext, name);
        }
    }

    /** The column a form control is bound to (its own name if that can't be found out). */
    function columnOf(formContext, controlName) {
        try {
            var control = formContext.getControl(controlName);
            var attribute = control && control.getAttribute ? control.getAttribute() : null;
            return attribute ? attribute.getName() : controlName;
        } catch (e) {
            return controlName;
        }
    }

    function remount(formContext, name) {
        var control = formContext.getControl(name);
        if (!control || typeof control.setVisible !== "function" || (control.getVisible && !control.getVisible())) {
            return;
        }
        control.setVisible(false);
        // Give the form one render pass with the control removed, otherwise the two updates are batched.
        host.setTimeout(function () {
            control.setVisible(true);
        }, 200);
    }

    // Start downloading immediately, while the form is still loading.
    load();

    window.KVNToNMultiSelectLoader = host.KVNToNMultiSelectLoader = {
        /**
         * OnLoad handler. Optional extra parameters: the column names the N:N Multi-Select is on. When none are given,
         * every control on the form that failed to load is retried.
         */
        onLoad: function (executionContext) {
            var formContext = executionContext && executionContext.getFormContext ? executionContext.getFormContext() : null;
            var names = Array.prototype.slice.call(arguments, 1).filter(function (n) {
                return typeof n === "string" && n;
            });
            load().then(
                function () {
                    if (!formContext) return;
                    remountFailedControls(formContext, names);
                    // Late renders (slow networks, tabs that render after OnLoad) get two more checks.
                    host.setTimeout(function () {
                        remountFailedControls(formContext, names);
                    }, 400);
                    host.setTimeout(function () {
                        remountFailedControls(formContext, names);
                    }, 1500);
                },
                function () {
                    // Already reported by load(); the next form load tries again.
                }
            );
        },
    };
})();
