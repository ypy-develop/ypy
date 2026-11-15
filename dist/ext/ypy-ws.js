// SPDX-License-Identifier: MIT
(() => {
    let api;
    
    // Build a CSS selector for querySelectorAll, respecting prefix + metaCharacter
    function wsSelector(suffix) {
        let mc = ypy.config.metaCharacter || ':';
        let sel = `[${CSS.escape('ypy-ws' + mc + suffix)}]`;
        if (ypy.config.prefix) sel += `,[${CSS.escape(ypy.config.prefix + 'ws' + mc + suffix)}]`;
        return sel;
    }


    // ========================================
    // CONFIGURATION
    // ========================================
    
    function getConfig(element) {
        let ypyConfig = api.HCON.parse(api.attributeValue(element, 'ypy-config')).ws || {};

        return {
            reconnect: true,
            reconnectCodes: [
                1001, // Going Away
                1005, // No Status Received
                1006, // Abnormal Closure
                1011, // Internal Error
                1012, // Service Restart
                1013, // Try Again Later
                1014  // Bad Gateway
            ],
            reconnectDelay: 500,
            reconnectMaxDelay: 60000,
            reconnectMaxAttempts: Infinity,
            reconnectJitter: 0.3,
            pauseOnBackground: true,
            maxOutgoingMessagesQueueSize: 100,
            ...ypy.config.ws, // global defaults
            ...ypyConfig // ypy-config overrides
        };
    }
    
    // ========================================
    // URL NORMALIZATION
    // ========================================
    
    function normalizeWebSocketUrl(url) {
        // Already a WebSocket URL
        if (url.startsWith('ws://') || url.startsWith('wss://')) {
            return url;
        }

        // Convert http(s):// to ws(s)://
        if (url.startsWith('http://')) {
            return 'ws://' + url.slice(7);
        }
        if (url.startsWith('https://')) {
            return 'wss://' + url.slice(8);
        }

        // Relative URL - build absolute ws(s):// URL
        let protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let host = window.location.host;
        
        if (url.startsWith('//')) {
            // Protocol-relative URL
            return protocol + url;
        }
        
        if (url.startsWith('/')) {
            // Absolute path
            return protocol + '//' + host + url;
        }
        
        // Relative path - resolve against current location
        let basePath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
        return protocol + '//' + host + basePath + url;
    }
    
    // ========================================
    // CONNECTIONS
    // ========================================
    
    const connections = new Set();
    
    // The same pin as the one on fetch (config.mode): sockets stay on the page's own
    // origin unless config.mode is "cors". An unparsable URL is refused.
    function allowedOrigin(url) {
        if (ypy.config.mode === 'cors') return true;
        try { return new URL(url.replace(/^ws/, 'http')).origin === location.origin; } catch { return false; }
    }

    function getOrCreateConnection(url, element) {
        if (element._ypy.ws.connection) return element._ypy.ws.connection;
        let normalizedUrl = normalizeWebSocketUrl(url);
        if (!allowedOrigin(normalizedUrl)) {
            api.triggerEvent(element, 'ypy:security:blocked', {reason: 'websocket-origin', url: normalizedUrl});
            return null;
        }

        let connection = {
            url: normalizedUrl,
            config: getConfig(element),
            socket: null,
            attempt: 0,
            timer: null,
            queue: [],
            receiving: Promise.resolve(),
            sending: Promise.resolve(),
            abortController: null,
            visibilityHandler: null,
            cancelled: false
        };

        if (!api.triggerEvent(element, 'ypy:ws:before:connection', {connection}) || connection.cancelled) {
            api.triggerEvent(element, 'ypy:ws:close', {
                connection, reason: 'cancelled', code: null
            });
            return null;
        }

        element._ypy.ws.connection = connection;
        connections.add(connection);
        createWebSocket(element, connection);

        let config = connection.config;
        if (config.pauseOnBackground) {
            connection.visibilityHandler = () => {
                if (document.hidden) {
                    if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
                        connection.socket.close();
                    }
                } else if (!connection.socket || connection.socket.readyState === WebSocket.CLOSED) {
                    connection.attempt = 0;
                    createWebSocket(element, connection);
                }
            };
            document.addEventListener('visibilitychange', connection.visibilityHandler);
        }

        return connection;
    }
    
    function cleanupConnection(element, connection) {
        if (connection.timer) clearTimeout(connection.timer);
        if (connection.visibilityHandler) {
            document.removeEventListener('visibilitychange', connection.visibilityHandler);
        }
        if (connection.abortController) {
            connection.abortController.abort();
        }
        connection.queue.length = 0;
        if (connection.socket) {
            try {
                if (connection.socket.readyState === WebSocket.OPEN || connection.socket.readyState === WebSocket.CONNECTING) {
                    connection.socket.close();
                }
            } catch (e) {
                // Socket may already be in an invalid state
            }
        }
        if (element._ypy?.ws?.connection === connection) delete element._ypy.ws.connection;
        connections.delete(connection);
    }

    function createWebSocket(element, connection) {
        let url = connection.url;
        // Abort old socket's listeners and close it
        if (connection.abortController) {
            connection.abortController.abort();
        }
        if (connection.socket) {
            let oldSocket = connection.socket;
            connection.socket = null;
            try {
                if (oldSocket.readyState === WebSocket.OPEN || oldSocket.readyState === WebSocket.CONNECTING) {
                    oldSocket.close();
                }
            } catch (e) {
                // Socket may already be in an invalid state
            }
        }

        try {
            connection.socket = new WebSocket(url, connection.config?.protocols);
            let ac = new AbortController();
            connection.abortController = ac;
            let opts = { signal: ac.signal };

            connection.socket.addEventListener('open', () => {
                if (element.isConnected) {
                    api.triggerEvent(element, 'ypy:ws:after:connection', {connection});
                } else {
                    cleanupConnection(element, connection);
                    return;
                }
                connection.attempt = 0;
                flushQueue(connection);
            }, opts);

            connection.socket.addEventListener('message', (event) => {
                connection.receiving = connection.receiving
                    .then(() => handleMessage(element, connection, event))
                    .catch(error => {
                        if (element.isConnected) api.triggerEvent(element, 'ypy:ws:error', {connection, error});
                    });
            }, opts);

            connection.socket.addEventListener('close', (event) => {
                if (event.target !== connection.socket) return;

                if (element.isConnected) api.triggerEvent(element, 'ypy:ws:close', {
                    connection, reason: 'closed', code: event.code
                });

                if (!connections.has(connection)) return;

                let config = connection.config;
                if (config.pauseOnBackground && document.hidden) return;

                if (config.reconnect && config.reconnectCodes.includes(event.code) && element.isConnected) {
                    scheduleReconnect(element, connection);
                } else {
                    cleanupConnection(element, connection);
                }
            }, opts);

            connection.socket.addEventListener('error', (error) => {
                if (element.isConnected) api.triggerEvent(element, 'ypy:ws:error', {connection, error});
            }, opts);

        } catch (error) {
            if (element.isConnected) api.triggerEvent(element, 'ypy:ws:error', {connection, error});
        }
    }
    
    function scheduleReconnect(element, connection) {
        let config = connection.config;

        connection.attempt++;
        let attempt = connection.attempt;

        if (!config.reconnect || attempt > config.reconnectMaxAttempts) {
            cleanupConnection(element, connection);
            return;
        }

        let baseDelay = ypy.parseInterval(config.reconnectDelay) ?? config.reconnectDelay;
        let maxDelay = ypy.parseInterval(config.reconnectMaxDelay) ?? config.reconnectMaxDelay;

        let delay = Math.min(
            baseDelay * Math.pow(2, attempt - 1),
            maxDelay
        );

        if (config.reconnectJitter > 0) {
            let jitterRange = delay * config.reconnectJitter;
            delay = Math.max(0, delay + (Math.random() * 2 - 1) * jitterRange);
        }

        if (element.isConnected) {
            connection.cancelled = false;
            if (!api.triggerEvent(element, 'ypy:ws:before:connection', {connection}) || connection.cancelled) {
                api.triggerEvent(element, 'ypy:ws:close', {
                    connection, reason: 'cancelled', code: null
                });
                cleanupConnection(element, connection);
                return;
            }
        } else {
            cleanupConnection(element, connection);
            return;
        }

        connection.timer = setTimeout(() => {
            if (element.isConnected) {
                createWebSocket(element, connection);
            } else {
                cleanupConnection(element, connection);
            }
        }, delay);
    }
    
    // ========================================
    // MESSAGES
    // ========================================

    function transmitMessage(connection, element, message) {
        try {
            connection.socket.send(message.data);
            api.triggerEvent(element, 'ypy:ws:after:message:outgoing', {connection, message});
        } catch (error) {
            api.triggerEvent(element, 'ypy:ws:error', {connection, error});
        }
    }

    function flushQueue(connection) {
        while (connection.queue.length && connection.socket?.readyState === WebSocket.OPEN) {
            let queuedMessage = connection.queue.shift();
            transmitMessage(connection, queuedMessage.element, queuedMessage.message);
        }
    }

    async function sendMessage(element, event) {
        let owner = element.closest(wsSelector('connect'));
        let url = owner && api.attributeValue(owner, 'ypy-ws:connect');

        if (!url) {
            api.triggerEvent(element, 'ypy:ws:error', {
                url: null, error: 'No WebSocket connection found for element'
            });
            return;
        }

        let normalizedUrl = normalizeWebSocketUrl(url);
        let connection = owner._ypy?.ws?.connection;

        if (!connection) {
            api.triggerEvent(element, 'ypy:ws:error', { url: normalizedUrl, error: 'Connection not open' });
            return;
        }

        // Build headers using core's request context (same as HTTP requests)
        let ctx = api.createRequestContext(element, event);
        let headers = {...ctx.request.headers};
        delete headers['Accept'];

        // Build outgoing values from form data.
        let form = element.form || element.closest('form');
        let formData = api.collectFormData(element, form, event.submitter);

        // Preserve multi-value form fields (checkboxes, multi-selects)
        let values = {};
        for (let [key, value] of formData) {
            if (key in values) {
                values[key] = [].concat(values[key], value);
            } else {
                values[key] = value;
            }
        }

        // Merge ypy-vals after serialization to preserve JS types (numbers, booleans)
        let ypyValsResult = api.getAttributeObject(element, 'ypy-vals', obj => Object.assign(values, obj));

        let outgoingMessage = connection.sending.then(async () => {
            if (ypyValsResult) await ypyValsResult;
            delete values.headers;

            let pendingWork = [];
            let message = {
                headers,
                values,
                data: undefined
            };
            let detail = {
                connection,
                message,
                cancelled: false,
                waitUntil(promise) {
                    pendingWork.push(Promise.resolve(promise));
                }
            };
            let shouldSend = api.triggerEvent(element, 'ypy:ws:before:message:outgoing', detail);

            try {
                await Promise.all(pendingWork);
                if (!shouldSend || detail.cancelled) return;

                message.data ??= JSON.stringify({ ...message.values, headers: message.headers });
                if (!connections.has(connection)) {
                    api.triggerEvent(element, 'ypy:ws:error', {connection, error: 'Connection closed'});
                    return;
                }

                if (connection.socket?.readyState === WebSocket.OPEN) {
                    transmitMessage(connection, element, message);
                } else if (connection.queue.length >= connection.config.maxOutgoingMessagesQueueSize) {
                    api.triggerEvent(element, 'ypy:ws:error', {
                        connection,
                        error: 'Outgoing messages queue is full'
                    });
                } else {
                    connection.queue.push({element, message});
                }
            } catch (error) {
                api.triggerEvent(element, 'ypy:ws:error', {connection, error});
            }
        });
        connection.sending = outgoingMessage.catch(() => {});
        await outgoingMessage;
    }
    
    // ========================================
    // MESSAGE RECEIVING & ROUTING
    // ========================================
    
    async function handleMessage(element, connection, event) {
        let pendingWork = [];
        let message = {
            data: event.data,
            text() {
                let data = message.data;
                return typeof data === 'string'
                    ? Promise.resolve(data)
                    : data instanceof Blob
                        ? data.text()
                        : Promise.resolve(new TextDecoder().decode(data));
            },
            json() {
                return message.text().then(JSON.parse);
            }
        };

        if (!element.isConnected) {
            cleanupConnection(element, connection);
            return;
        }

        let detail = {
            connection,
            message,
            cancelled: false,
            waitUntil(promise) {
                pendingWork.push(Promise.resolve(promise));
            }
        };
        let shouldProcess = api.triggerEvent(element, 'ypy:ws:before:message:incoming', detail);

        await Promise.all(pendingWork);
        if (!shouldProcess || detail.cancelled) return;

        let json = null;
        let html;
        if (typeof message.data === 'string') {
            try {
                json = await message.json();
            } catch (e) {
                html = await message.text();
            }
        }

        // JSON with 'content' or 'payload' field: swap the HTML
        // Raw (non-JSON) string: swap the entire string as HTML
        // JSON without 'content'/'payload': data-only message, no swap (handle via events)
        if (json) {
            if (json.content !== undefined) {
                html = json.content;
            } else if (json.payload !== undefined) {
                html = json.payload; // backwards compat
                // Warn once per connection (not on every message)
                if (!connection._payloadWarnFired) {
                    console.warn('ypy: [ypy-ws] json.payload is deprecated; use json.content instead');
                    connection._payloadWarnFired = true;
                }
            }
        }
        if (html != null) {
            let target = json?.target || api.attributeValue(element, 'ypy-target');
            let swap = json?.swap || api.attributeValue(element, 'ypy-swap') || ypy.config.defaultSwap;
            if (!/(?:^|\s)swapEmpty(?::(?:true|false))?(?=\s|$)/.test(swap)) swap += ' swapEmpty:false';

            await ypy.swap({
                sourceElement: element,
                target: target || element,
                swap,
                select: json?.select ?? api.attributeValue(element, 'ypy-select'),
                selectOOB: api.attributeValue(element, 'ypy-select-oob'),
                text: html,
                transition: false
            });
        }

        api.triggerEvent(element, 'ypy:ws:after:message:incoming', {connection, message});
    }
    
    // ========================================
    // ELEMENT LIFECYCLE
    // ========================================
    
    function initializeElement(element) {
        api.ypyProp(element).ws ??= {};
        if (element._ypy.ws.initialized) return;

        let connectUrl = api.attributeValue(element, 'ypy-ws:connect');
        if (!connectUrl) return;

        let specString = api.attributeValue(element, 'ypy-trigger') || 'load';
        api.onTrigger(element, specString, () => {
            getOrCreateConnection(connectUrl, element);
        });
        element._ypy.ws.initialized = true;
    }
    
    function initializeSendElement(element) {
        api.ypyProp(element).ws ??= {};
        if (element._ypy.ws.sendInitialized) return;

        let specString = api.attributeValue(element, 'ypy-trigger');
        if (!specString) {
            specString = element.matches('form') ? 'submit' :
                         element.matches('input:not([type=button]):not([type=submit]),select,textarea') ? 'change' :
                         'click';
        }

        api.onTrigger(element, specString, async (evt) => {
            if (element.matches('form') && evt.type === 'submit') {
                evt.preventDefault();
            }
            await sendMessage(element, evt);
        });
        element._ypy.ws.sendInitialized = true;
    }
    
    function cleanupElement(element) {
        let connection = element._ypy?.ws?.connection;
        if (!connection) return;
        api.triggerEvent(element, 'ypy:ws:close', {
            connection, reason: 'removed', code: null
        });
        cleanupConnection(element, connection);
    }
    
    // ========================================
    // BACKWARD COMPATIBILITY
    // ========================================
    
    function checkLegacyAttributes(element) {
        if (element.hasAttribute('ypy-ws-connect') || element.hasAttribute('ypy-ws-send')) {
            console.warn('ypy: [ypy-ws] legacy attributes ypy-ws-connect and ypy-ws-send are deprecated; use ypy-ws:connect and ypy-ws:send instead');

            if (element.hasAttribute('ypy-ws-connect')) {
                let url = element.getAttribute('ypy-ws-connect');
                let mc = ypy.config.metaCharacter || ':';
                let attr = (ypy.config.prefix || 'ypy-') + 'ws' + mc + 'connect';
                if (!element.hasAttribute(attr)) {
                    element.setAttribute(attr, url);
                }
            }

            if (element.hasAttribute('ypy-ws-send')) {
                let mc = ypy.config.metaCharacter || ':';
                let attr = (ypy.config.prefix || 'ypy-') + 'ws' + mc + 'send';
                if (!element.hasAttribute(attr)) {
                    element.setAttribute(attr, '');
                }
            }
        }
    }
    
    // ========================================
    // EXTENSION REGISTRATION
    // ========================================
    
    ypy.registerExtension('ypy-ws', {
        init: (internalAPI) => {
            api = internalAPI;
            
            // Initialize default config if not set
            if (!ypy.config.ws) {
                ypy.config.ws = {};
            }
        },
        
        ypy_after_process: (element) => {
            const processNode = (node) => {
                checkLegacyAttributes(node);

                let send = api.attributeValue(node, 'ypy-ws:send');
                if (api.attributeValue(node, 'ypy-ws:connect') != null) {
                    initializeElement(node);
                }

                if (send != null) {
                    initializeSendElement(node);
                }
            };

            processNode(element);

            let sel = wsSelector('connect') + ',' + wsSelector('send') + ',[ypy-ws-connect],[ypy-ws-send]';
            element.querySelectorAll(sel).forEach(processNode);
        },
        
        ypy_before_cleanup: (element) => {
            cleanupElement(element);
        }
    });
    
    if (typeof window !== 'undefined' && window.ypy) {
        // Clean up all WS connections on page navigation to prevent browser errors
        window.addEventListener('pagehide', () => {
            connections.forEach((connection) => {
                if (connection.socket) {
                    connection.socket.close(1000, 'page navigating away');
                }
            });
        });

    }
})();
