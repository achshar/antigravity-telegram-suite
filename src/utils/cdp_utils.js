const CDP = require('chrome-remote-interface');
const http = require('http');

/**
 * Simple HTTP GET helper.
 */
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

/**
 * Connects to a CDP target, injects UI_LOCATORS, and evaluates the given script.
 * 
 * @param {string} targetUrl The webSocketDebuggerUrl of the target
 * @param {string} uiLocatorsScript The UI_LOCATORS_SCRIPT string to inject
 * @param {string} scriptFnBody The body of the anonymous function to evaluate
 * @returns {Promise<any>} The parsed result of the evaluation, or undefined if failed
 */
async function evaluateInTarget(targetUrl, uiLocatorsScript, scriptFnBody) {
    let client;
    try {
        client = await CDP({ target: targetUrl });
        const { Runtime } = client;
        await Runtime.enable();
        
        const res = await Runtime.evaluate({
            expression: `
                ${uiLocatorsScript}
                (() => {
                    ${scriptFnBody}
                })()
            `,
            returnByValue: true
        });
        
        return res.result?.value;
    } catch (e) {
        // Suppress generic CDP connection errors to avoid console spam when tabs close
        return undefined;
    } finally {
        if (client) {
            await client.close().catch(() => {});
        }
    }
}

/**
 * Fetches and sorts available CDP targets.
 * Ensures the currently focused IDE window or a user-preferred window is prioritized.
 */
async function resolveTargets(port, preferredTargetId, includeIframe = true) {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets = JSON.parse(raw);
    const typeFilter = includeIframe
        ? t => (t.type === 'page' || t.type === 'iframe' || t.type === 'webview')
        : t => (t.type === 'page' || t.type === 'webview');
        
    const candidates = targets.filter(t => typeFilter(t) &&
        t.webSocketDebuggerUrl &&
        !t.url.includes('devtools://') &&
        !(t.title && t.title.includes('Launchpad')));

    // Determine which target currently has focus
    let focusedTargetId = null;
    try {
        const focusChecks = candidates.map(async (target) => {
            const result = await evaluateInTarget(target.webSocketDebuggerUrl, '', 'return document.hasFocus();');
            if (result) return target.id;
            return null;
        });
        const results = await Promise.all(focusChecks);
        focusedTargetId = results.find(id => id !== null);
    } catch (_) {}

    candidates.sort((a, b) => {
        // Preferred target by ID always wins (set via /window command)
        if (preferredTargetId) {
            if (a.id === preferredTargetId) return -1;
            if (b.id === preferredTargetId) return 1;
        }
        // Fallback: prefer the currently focused window
        if (focusedTargetId) {
            if (a.id === focusedTargetId) return -1;
            if (b.id === focusedTargetId) return 1;
        }
        return 0;
    });

    return candidates;
}

module.exports = {
    httpGet,
    evaluateInTarget,
    resolveTargets
};
